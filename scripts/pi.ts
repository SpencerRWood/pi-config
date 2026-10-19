import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { verifyInstallation } from "../lib/install.ts";
import { prepareStory, storyPrompt } from "../lib/story.ts";

// Explicit supported configuration only: no default home or legacy fallback.
const separator = process.argv.indexOf("--");
const configArgs =
  separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
const piArgs = separator < 0 ? [] : process.argv.slice(separator + 1);
const { values } = parseArgs({
  args: configArgs,
  options: {
    "agent-dir": { type: "string" },
    story: { type: "string" },
    owner: { type: "string" },
    worktree: { type: "string" },
    initiative: { type: "string" },
    "branch-prefix": { type: "string" },
    "hotfix-incident": { type: "string" },
    "hotfix-approval": { type: "string" },
  },
});
if (!values["agent-dir"])
  throw new Error("Required: --agent-dir PATH [-- PI_ARGS]");
const { repo } = verifyInstallation(values["agent-dir"]);
if (
  !values.story &&
  (values.owner ||
    values.worktree ||
    values.initiative ||
    values["branch-prefix"] ||
    values["hotfix-incident"] ||
    values["hotfix-approval"])
)
  throw new Error("Story selectors require --story");
if (values.story && (!values.owner || !values.worktree))
  throw new Error("Story launch requires --owner and --worktree");
const story = values.story
  ? prepareStory(
      {
        story: values.story,
        owner: values.owner!,
        worktree: values.worktree!,
        initiative: values.initiative,
        branchPrefix: values["branch-prefix"],
        hotfixIncident: values["hotfix-incident"],
        hotfixApproval: values["hotfix-approval"],
      },
      process.cwd(),
    )
  : undefined;
if (story)
  process.stderr.write(
    JSON.stringify({
      story: story.id,
      owner: story.owner,
      worktree: story.worktree,
      sessionFile: story.sessionFile,
    }) + "\n",
  );
const child = spawn(
  process.execPath,
  [
    join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    ...piArgs,
    ...(story ? ["--append-system-prompt", storyPrompt(story)] : []),
  ],
  {
    stdio: "inherit",
    cwd: story?.worktree ?? process.cwd(),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: values["agent-dir"],
      WOOD_PI_STORY_ID: story ? String(story.id) : "",
      WOOD_PI_STORY_OWNER: story?.owner ?? "",
    },
  },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
