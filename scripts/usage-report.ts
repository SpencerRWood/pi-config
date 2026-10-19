import { parseArgs } from "node:util";
import { readUsage, storyUsage } from "../lib/usage.ts";

const { values } = parseArgs({
  options: { "agent-dir": { type: "string" }, story: { type: "string" } },
  strict: true,
});
if (
  !values["agent-dir"] ||
  !/^[1-9][0-9]*$/.test(values.story ?? "") ||
  !Number.isSafeInteger(Number(values.story))
)
  throw new Error("Usage: --agent-dir <absolute-private-home> --story <id>");
console.log(
  JSON.stringify(
    storyUsage(readUsage(values["agent-dir"]), Number(values.story)),
    null,
    2,
  ),
);
