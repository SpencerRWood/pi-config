import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

type Envelope = {
  schema_version: number;
  status: string;
  summary: string;
  requires_approval: boolean;
  data: Record<string, unknown>;
};

export type WoodRunner = (args: string[], cwd: string) => Envelope;

export const runWood: WoodRunner = (args, cwd) => {
  let output: string;
  try {
    output = execFileSync("wood", [...args, "--json"], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Failed Wood commands still return bounded envelopes. Do not expose stderr,
    // credentials, arbitrary command output or the inherited process environment.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout !== "string" || !stdout.trim())
      throw new Error(
        "Wood unavailable; inspect installation and command access",
      );
    output = stdout;
  }
  let result: Envelope;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error("Wood returned invalid JSON");
  }
  if (
    result?.schema_version !== 2 ||
    typeof result.summary !== "string" ||
    typeof result.data !== "object" ||
    result.data === null
  )
    throw new Error("Wood returned an unsupported envelope");
  if (result.status !== "success" || result.requires_approval !== false)
    throw new Error(`Wood ${result.status}: ${result.summary.slice(0, 500)}`);
  return result;
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Wood returned incomplete Story session data");
  return value as Record<string, unknown>;
}

export type StoryOptions = {
  story: string;
  owner: string;
  worktree: string;
  initiative?: string;
};

// Wood owns readiness, Git preparation, claims and transitions. Pi supplies only
// an explicit local identity and uses the returned worktree as its working directory.
export function prepareStory(
  options: StoryOptions,
  cwd: string,
  run: WoodRunner = runWood,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(options.owner))
    throw new Error(
      "--owner must be a stable session ID (1–100 safe characters)",
    );
  if (!isAbsolute(options.worktree))
    throw new Error("--worktree must be an absolute path");
  if (options.story !== "next" && !/^[1-9][0-9]*$/.test(options.story))
    throw new Error("--story must be next or a positive Story ID");
  if (options.initiative && !/^[1-9][0-9]*$/.test(options.initiative))
    throw new Error("--initiative must be a positive Initiative ID");
  const capabilities = run(["contract"], cwd).data.capabilities;
  if (
    !Array.isArray(capabilities) ||
    ![
      "story next",
      "story get",
      "story start",
      "story session get",
      "story session checkpoint",
      "story session handoff",
      "story session release",
    ].every((command) => capabilities.includes(command))
  )
    throw new Error(
      "Install Wood Tools with Story session/worktree support before launching",
    );
  const id =
    options.story === "next"
      ? object(
          run(
            [
              "story",
              "next",
              ...(options.initiative ? [options.initiative] : []),
            ],
            cwd,
          ).data.story,
        ).id
      : Number(options.story);
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    throw new Error("Wood returned no eligible Story ID");
  const packet = run(["story", "get", String(id)], cwd).data;
  const implementation = object(packet.implementation);
  const criteria = implementation.acceptance_criteria;
  if (
    typeof implementation.goal !== "string" ||
    !implementation.goal.trim() ||
    !Array.isArray(criteria) ||
    criteria.length === 0 ||
    !criteria.every((criterion) => typeof criterion === "string")
  )
    throw new Error(
      "Story goal and acceptance criteria are required before activation",
    );
  const args = [
    "story",
    "start",
    String(id),
    "--owner",
    options.owner,
    "--worktree",
    options.worktree,
    ...(options.initiative ? ["--initiative", options.initiative] : []),
  ];
  run(args, cwd); // readiness preview; apply rechecks under Wood's shared lock
  const started = run([...args, "--apply"], cwd).data;
  const session = object(started.session);
  const worktree = object(started.worktree);
  if (
    session.story_id !== id ||
    session.owner !== options.owner ||
    session.state !== "claimed" ||
    worktree.path !== session.worktree ||
    typeof session.worktree !== "string" ||
    resolve(session.worktree) !== resolve(options.worktree) ||
    typeof session.branch !== "string" ||
    !session.branch.startsWith(`feature/op-${id}-`) ||
    typeof started.session_file !== "string"
  )
    throw new Error(
      "Wood returned a mismatched Story/worktree binding; inspect its local claim",
    );
  return {
    id,
    owner: options.owner,
    worktree: session.worktree,
    branch: session.branch,
    sessionFile: started.session_file,
    goal: implementation.goal,
    acceptanceCriteria: criteria as string[],
    nextAction: session.next_action,
  };
}

export function storyPrompt(story: ReturnType<typeof prepareStory>) {
  return [
    `Active Wood Story #${story.id}. Owner: ${story.owner}. Branch: ${story.branch}.`,
    `Working directory: ${story.worktree}. Durable session: ${story.sessionFile}.`,
    `Goal: ${story.goal}`,
    `Acceptance criteria: ${JSON.stringify(story.acceptanceCriteria)}`,
    "Read the shared openproject-development-workflow skill before implementation.",
    `Use --owner ${story.owner} on Wood lifecycle/activity writes. Do not share this owner with concurrent agents.`,
    `Inspect recovery with wood story session get ${story.id} --json.`,
    "Checkpoint with wood story session checkpoint using --owner, --phase, --next-action and saved --record paths; preview before --apply.",
    `Generate a cross-agent recovery artifact with wood story session handoff ${story.id} --json, then --apply.`,
    "Saved paths are references, not passed validation. Retain Wood validation/evidence records through delivery.",
    "Stop before commit/push/PR creation for review. Keep the claim on exit; resume with the same owner and worktree.",
    "Release the claim explicitly only after the current execution stops and its handoff/evidence is retained.",
  ].join("\n");
}
