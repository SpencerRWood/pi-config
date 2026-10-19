import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DriveError } from "./drive-config.ts";
import {
  refreshKey,
  scopeFor,
  tokenRequest,
  type SecretStore,
} from "./drive-auth.ts";
import type { Grant } from "./drive-config.ts";

// The callback never logs request URLs, codes, token responses or credentials.
export async function consent(options: {
  grant: Grant;
  clientType: "desktop" | "web";
  account: string;
  port: number;
  secrets: SecretStore;
  openBrowser: (url: string) => Promise<void>;
  transport?: typeof fetch;
  timeoutMs?: number;
}) {
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.account) ||
    !Number.isInteger(options.port) ||
    options.port < 1024 ||
    options.port > 65535 ||
    !["desktop", "web"].includes(options.clientType)
  )
    throw new DriveError(
      "INVALID_AUTH_CONFIGURATION",
      "Supply the OAuth client type, expected Google account and a loopback port from 1024 to 65535.",
    );
  const transport = options.transport ?? fetch;
  const [clientId, clientSecret] = await Promise.all([
    options.secrets.get("GOOGLE_DRIVE_CLIENT_ID"),
    options.secrets.get("GOOGLE_DRIVE_CLIENT_SECRET"),
  ]);
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const redirectUri = `http://127.0.0.1:${options.port}/oauth2callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopeFor(options.grant),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    login_hint: options.account,
  }).toString();
  let timer: NodeJS.Timeout | undefined;
  let completed = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: unknown) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Register a handler before browser startup so an early callback rejection is observed.
  void codePromise.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    const callback = new URL(request.url ?? "/", redirectUri);
    const received = callback.searchParams.get("state") ?? "";
    if (
      request.method !== "GET" ||
      callback.pathname !== "/oauth2callback" ||
      Buffer.byteLength(received) !== Buffer.byteLength(state) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(state)) ||
      completed
    ) {
      response.writeHead(400).end("Invalid OAuth callback.");
      return;
    }
    const code = callback.searchParams.get("code");
    completed = true;
    if (!code || callback.searchParams.has("error")) {
      response
        .writeHead(400)
        .end("Google consent was not granted. Return to the terminal.");
      rejectCode(
        new DriveError(
          "CONSENT_DENIED",
          "Google consent was declined or incomplete. Run consent again when ready.",
        ),
      );
      return;
    }
    response.end(
      "Authorization received. Return to the terminal for verification.",
    );
    resolveCode(code);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () =>
        reject(
          new DriveError(
            "CALLBACK_UNAVAILABLE",
            "Cannot bind the loopback callback port. Choose an unused port and check the registered Web redirect URI.",
          ),
        ),
      );
      server.listen(options.port, "127.0.0.1", () => resolve());
    });
    timer = setTimeout(
      () =>
        rejectCode(
          new DriveError(
            "CONSENT_TIMEOUT",
            "Google consent timed out. Run the command again.",
          ),
        ),
      options.timeoutMs ?? 180_000,
    );
    await options.openBrowser(url.toString());
    const code = await codePromise;
    const token = await tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
      transport,
    );
    if (token.scope !== scopeFor(options.grant) || !token.refresh_token)
      throw new DriveError(
        "SCOPE_MISMATCH",
        "Google did not issue the exact requested scope and offline refresh token. Check prior grants and consent configuration; never store a broader grant as read-only.",
      );
    let account: { user?: { emailAddress?: string } };
    try {
      const response = await transport(
        "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
        {
          headers: { Authorization: `Bearer ${token.access_token}` },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) throw new Error();
      account = (await response.json()) as typeof account;
    } catch {
      throw new DriveError(
        "ACCOUNT_VERIFICATION_FAILED",
        "Could not verify the Google account; check that Drive API is enabled. No refresh token was saved.",
      );
    }
    if (
      account.user?.emailAddress?.toLowerCase() !==
      options.account.toLowerCase()
    )
      throw new DriveError(
        "ACCOUNT_MISMATCH",
        "Consent used a different Google account. No refresh token was saved; repeat consent with the approved account.",
      );
    await options.secrets.set(refreshKey(options.grant), token.refresh_token);
    return {
      grant: options.grant,
      scope: scopeFor(options.grant),
      account: options.account,
      stored: true,
    };
  } finally {
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
