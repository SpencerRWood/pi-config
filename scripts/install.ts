import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { install } from "../lib/install.ts";

const { values } = parseArgs({
  options: {
    "codex-config": { type: "string" },
    "agent-dir": { type: "string" },
  },
});
if (!values["codex-config"] || !values["agent-dir"])
  throw new Error("Required: --codex-config PATH --agent-dir ABSOLUTE_PATH");
const repo = fileURLToPath(new URL("..", import.meta.url));
console.log(
  JSON.stringify(install(repo, values["codex-config"], values["agent-dir"])),
);
