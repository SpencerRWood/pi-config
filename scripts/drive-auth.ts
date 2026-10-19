import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import {
  DriveError,
  loadDriveConfig,
  safeDriveError,
} from "../lib/drive-config.ts";
import { InfisicalDriveSecrets } from "../lib/drive-auth.ts";
import { consent } from "../lib/drive-consent.ts";

try {
  const { values } = parseArgs({
    options: {
      "agent-dir": { type: "string" },
      grant: { type: "string" },
      "client-type": { type: "string" },
      account: { type: "string" },
      port: { type: "string", default: "8716" },
      browser: { type: "string", default: "system" },
      "timeout-seconds": { type: "string", default: "180" },
    },
  });
  if (
    !values["agent-dir"] ||
    !["read", "write"].includes(values.grant ?? "") ||
    !["desktop", "web"].includes(values["client-type"] ?? "") ||
    !values.account
  )
    throw new Error();
  const timeoutSeconds = Number(values["timeout-seconds"]);
  if (
    !["system", "link"].includes(values.browser!) ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 30 ||
    timeoutSeconds > 900
  )
    throw new DriveError(
      "INVALID_AUTH_CONFIGURATION",
      "Use --browser system|link and --timeout-seconds between 30 and 900.",
    );
  const config = loadDriveConfig(values["agent-dir"]);
  const result = await consent({
    grant: values.grant as "read" | "write",
    clientType: values["client-type"] as "desktop" | "web",
    account: values.account,
    port: Number(values.port),
    secrets: new InfisicalDriveSecrets(config.infisical),
    timeoutMs: timeoutSeconds * 1000,
    openBrowser: async (url) => {
      if (values.browser === "link") {
        // This URL contains public OAuth parameters, never client_secret,
        // the PKCE verifier, authorization codes or bearer/refresh tokens.
        process.stdout.write(
          JSON.stringify({
            authorizationUrl: url,
            callbackUri: `http://127.0.0.1:${values.port}/oauth2callback`,
            timeoutSeconds,
          }) + "\n",
        );
        process.stderr.write(
          "Open the sign-in link in your external browser. For a phone browser, first forward phone 127.0.0.1:" +
            values.port +
            " to Mac 127.0.0.1:" +
            values.port +
            " through SSH. Do not paste callback URLs or tokens into chat.\n",
        );
        return;
      }
      if (process.platform !== "darwin") throw new Error();
      await promisify(execFile)("open", [url], { timeout: 10_000 });
      process.stderr.write(
        "Complete Google consent in the browser. Credential values will not be printed.\n",
      );
    },
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      ...safeDriveError(error),
      usage:
        "node --import tsx scripts/drive-auth.ts --agent-dir ABSOLUTE_PATH --grant read|write --client-type desktop|web --account EMAIL [--port 8716] [--browser system|link] [--timeout-seconds 180]",
    }) + "\n",
  );
  process.exitCode = 1;
}
