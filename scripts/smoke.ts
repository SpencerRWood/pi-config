import { parseArgs } from "node:util";
import { smoke } from "../lib/smoke.ts";

const { values } = parseArgs({ options: { "agent-dir": { type: "string" } } });
if (!values["agent-dir"]) throw new Error("Required: --agent-dir PATH");
console.log(JSON.stringify(await smoke(values["agent-dir"], process.cwd())));
