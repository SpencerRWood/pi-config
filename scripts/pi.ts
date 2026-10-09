import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { verifyInstallation } from "../lib/install.ts";

// Explicit supported configuration only: no default home or legacy fallback.
const separator = process.argv.indexOf("--");
const configArgs =
  separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
const piArgs = separator < 0 ? [] : process.argv.slice(separator + 1);
const { values } = parseArgs({
  args: configArgs,
  options: { "agent-dir": { type: "string" } },
});
if (!values["agent-dir"])
  throw new Error("Required: --agent-dir PATH [-- PI_ARGS]");
const { repo } = verifyInstallation(values["agent-dir"]);
const child = spawn(
  process.execPath,
  [
    join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    ...piArgs,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: values["agent-dir"] },
  },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
