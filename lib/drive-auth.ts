import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DriveError,
  READ_SCOPE,
  WRITE_SCOPE,
  type DriveConfig,
  type Grant,
} from "./drive-config.ts";

const exec = promisify(execFile);
export interface SecretStore {
  get(name: string): Promise<string>;
  set(name: string, value: string): Promise<void>;
}

export class InfisicalDriveSecrets implements SecretStore {
  constructor(private readonly config: DriveConfig["infisical"]) {}
  private args() {
    return [
      "--env",
      this.config.environment,
      "--path",
      this.config.path,
      "--silent",
    ];
  }
  async get(name: string) {
    try {
      const { stdout } = await exec(
        "infisical",
        ["secrets", "get", name, ...this.args(), "--plain"],
        {
          cwd: this.config.configDir,
          timeout: 20_000,
          maxBuffer: 65_536,
        },
      );
      const value = stdout.trim();
      if (!value || /[\r\n]/.test(value)) throw new Error();
      return value;
    } catch {
      throw new DriveError(
        "CREDENTIAL_UNAVAILABLE",
        `Infisical could not supply ${name}; check login, environment, path and permissions.`,
      );
    }
  }
  async set(name: string, value: string) {
    if (
      !/^GOOGLE_DRIVE_(?:READ|WRITE)_REFRESH_TOKEN$/.test(name) ||
      !value ||
      /[\r\n]/.test(value)
    )
      throw new DriveError(
        "INVALID_CREDENTIAL",
        "Refusing an invalid refresh-token write.",
      );
    // Values travel only on stdin, never argv, env files, diagnostics or logs.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "infisical",
        ["secrets", "set", ...this.args(), "--file", "/dev/stdin"],
        {
          cwd: this.config.configDir,
          timeout: 20_000,
          maxBuffer: 65_536,
        },
        (error) =>
          error
            ? reject(
                new DriveError(
                  "CREDENTIAL_STORAGE_FAILED",
                  "Infisical could not save the refresh token. Retry consent after restoring secret-write access.",
                ),
              )
            : resolve(),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${name}=${value}\n`);
    });
  }
}

export const refreshKey = (grant: Grant) =>
  `GOOGLE_DRIVE_${grant.toUpperCase()}_REFRESH_TOKEN`;
export const scopeFor = (grant: Grant) =>
  grant === "read" ? READ_SCOPE : WRITE_SCOPE;
type Token = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

export async function tokenRequest(
  body: URLSearchParams,
  transport: typeof fetch = fetch,
): Promise<Token> {
  let response: Response;
  try {
    response = await transport("https://oauth2.googleapis.com/token", {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new DriveError(
      "AUTH_NETWORK_ERROR",
      "Google token endpoint is unreachable; check network connectivity.",
    );
  }
  let value: Record<string, unknown>;
  try {
    const decoded: unknown = await response.json();
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw new Error();
    value = decoded as Record<string, unknown>;
  } catch {
    throw new DriveError(
      "AUTH_RESPONSE_INVALID",
      "Google returned an invalid token response.",
    );
  }
  if (!response.ok) {
    const code =
      value.error === "invalid_grant"
        ? "CONSENT_REQUIRED"
        : value.error === "invalid_client"
          ? "OAUTH_CLIENT_INVALID"
          : "AUTHENTICATION_FAILED";
    throw new DriveError(
      code,
      code === "CONSENT_REQUIRED"
        ? "Refresh authorization was revoked or expired. Run the consent command again."
        : code === "OAUTH_CLIENT_INVALID"
          ? "Google rejected the OAuth client; verify both Infisical client keys and the Cloud client configuration."
          : "Google rejected authentication; verify consent, client type, scopes and redirect URI.",
      response.status,
    );
  }
  if (
    typeof value.access_token !== "string" ||
    !value.access_token ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (value.refresh_token !== undefined &&
      typeof value.refresh_token !== "string") ||
    (value.scope !== undefined && typeof value.scope !== "string")
  )
    throw new DriveError(
      "AUTH_RESPONSE_INVALID",
      "Google returned incomplete token data.",
    );
  return value as Token;
}

export class DriveTokens {
  private cached = new Map<Grant, { value: string; expires: number }>();
  private pending = new Map<Grant, Promise<string>>();
  constructor(
    private readonly secrets: SecretStore,
    private readonly transport: typeof fetch = fetch,
  ) {}
  invalidate(grant: Grant) {
    this.cached.delete(grant);
  }
  async access(grant: Grant): Promise<string> {
    const cached = this.cached.get(grant);
    if (cached && cached.expires > Date.now() + 60_000) return cached.value;
    const pending = this.pending.get(grant);
    if (pending) return pending;
    const refreshing = this.refresh(grant);
    this.pending.set(grant, refreshing);
    try {
      return await refreshing;
    } finally {
      this.pending.delete(grant);
    }
  }
  private async refresh(grant: Grant) {
    const [clientId, clientSecret, refreshToken] = await Promise.all([
      this.secrets.get("GOOGLE_DRIVE_CLIENT_ID"),
      this.secrets.get("GOOGLE_DRIVE_CLIENT_SECRET"),
      this.secrets.get(refreshKey(grant)),
    ]);
    const token = await tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      this.transport,
    );
    if (token.scope !== scopeFor(grant))
      throw new DriveError(
        "SCOPE_MISMATCH",
        "The stored grant has unexpected scopes; renew the separate least-privilege grant.",
      );
    if (token.refresh_token && token.refresh_token !== refreshToken)
      await this.secrets.set(refreshKey(grant), token.refresh_token);
    this.cached.set(grant, {
      value: token.access_token,
      expires: Date.now() + token.expires_in * 1000,
    });
    return token.access_token;
  }
}
