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

const strategies = ["trunk", "release", "integration"];
const prefixes = ["feature", "feat", "fix"];

function branchingPlan(value: unknown) {
  const plan = object(value);
  const hotfix = plan.mode === "hotfix";
  if (
    !strategies.includes(String(plan.strategy)) ||
    typeof plan.adopted !== "boolean" ||
    typeof plan.base_branch !== "string" ||
    !plan.base_branch ||
    (plan.mode !== undefined && !hotfix) ||
    (hotfix &&
      (plan.strategy !== "integration" ||
        plan.base_branch !== "main" ||
        typeof plan.integration_branch !== "string" ||
        !plan.integration_branch ||
        plan.integration_branch === "main" ||
        [plan.hotfix_incident, plan.hotfix_approval].some(
          (value) =>
            typeof value !== "string" || !value.trim() || value.length > 500,
        ))) ||
    plan.target_branch !== plan.base_branch ||
    (plan.strategy === "trunk"
      ? plan.base_branch !== "main"
      : plan.adopted !== true ||
        (!hotfix && plan.base_branch === "main") ||
        !Number.isSafeInteger(plan.release_id) ||
        Number(plan.release_id) < 1 ||
        typeof plan.scope_reference !== "string" ||
        !plan.scope_reference.trim())
  )
    throw new Error(
      "Wood returned an invalid branching plan before activation",
    );
  return plan;
}

function verifyStart(
  data: Record<string, unknown>,
  expected: Record<string, unknown>,
  id: number,
  options: StoryOptions,
) {
  const plan = branchingPlan(data.branching);
  const session = object(data.session);
  const worktree = object(data.worktree);
  const saved = object(session.branching);
  const branch = session.branch;
  const keys = [
    "strategy",
    "adopted",
    "base_branch",
    "target_branch",
    "release_id",
    "scope_reference",
    "mode",
    "integration_branch",
    "hotfix_incident",
    "hotfix_approval",
  ];
  const baseRef =
    plan.strategy === "trunk"
      ? "refs/heads/main"
      : `refs/remotes/origin/${plan.base_branch}`;
  if (
    keys.some(
      (key) => plan[key] !== expected[key] || saved[key] !== plan[key],
    ) ||
    plan.base_ref !== baseRef ||
    typeof plan.base_revision !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(plan.base_revision) ||
    saved.base_ref !== plan.base_ref ||
    saved.base_revision !== plan.base_revision ||
    (worktree.reused !== true &&
      worktree.base_revision !== plan.base_revision) ||
    session.story_id !== id ||
    session.owner !== options.owner ||
    session.state !== "claimed" ||
    worktree.path !== session.worktree ||
    typeof session.worktree !== "string" ||
    resolve(session.worktree) !== resolve(options.worktree) ||
    typeof branch !== "string" ||
    !prefixes.some((prefix) => branch.startsWith(`${prefix}/op-${id}-`)) ||
    (options.branchPrefix !== undefined &&
      !branch.startsWith(`${options.branchPrefix}/op-${id}-`)) ||
    worktree.branch !== session.branch ||
    typeof data.session_file !== "string"
  )
    throw new Error(
      "Wood returned a mismatched branching/Story/worktree binding; inspect its local claim",
    );
  return { session, plan };
}

export type StoryOptions = {
  story: string;
  owner: string;
  worktree: string;
  initiative?: string;
  branchPrefix?: string;
  hotfixIncident?: string;
  hotfixApproval?: string;
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
  if (
    options.branchPrefix !== undefined &&
    !prefixes.includes(options.branchPrefix)
  )
    throw new Error("Choose feature, feat or fix before activation");
  const hotfix =
    options.hotfixIncident !== undefined ||
    options.hotfixApproval !== undefined;
  if (
    hotfix &&
    (options.story === "next" ||
      [options.hotfixIncident, options.hotfixApproval].some(
        (value) =>
          typeof value !== "string" || !value.trim() || value.length > 500,
      ))
  )
    throw new Error(
      "Hotfix requires an explicit Story, incident and approval references",
    );
  const contract = run(["contract"], cwd).data;
  const capabilities = contract.capabilities;
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
      "repo branching",
    ].every((command) => capabilities.includes(command))
  )
    throw new Error(
      "Install Wood Tools with Story session/worktree support before launching",
    );
  const branching = object(contract.branching);
  const declaredStrategies = branching.strategies;
  const declaredPrefixes = branching.branch_prefixes;
  if (
    branching.version !== 1 ||
    !Array.isArray(declaredStrategies) ||
    !strategies.every((name) => declaredStrategies.includes(name)) ||
    !Array.isArray(declaredPrefixes) ||
    !prefixes.every((name) => declaredPrefixes.includes(name))
  )
    throw new Error("Install Wood Tools with branching contract version 1");
  const declared = branchingPlan(run(["repo", "branching"], cwd).data);
  if (
    hotfix &&
    (declared.strategy !== "integration" ||
      object(branching.hotfix).version !== 1)
  )
    throw new Error(
      "Hotfix requires integration strategy and Wood hotfix contract version 1",
    );
  const expected = hotfix
    ? branchingPlan({
        ...declared,
        mode: "hotfix",
        integration_branch: declared.base_branch,
        base_branch: "main",
        target_branch: "main",
        hotfix_incident: options.hotfixIncident,
        hotfix_approval: options.hotfixApproval,
      })
    : declared;
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
    "--base-branch",
    String(expected.base_branch),
    "--target-branch",
    String(expected.target_branch),
    ...(options.initiative ? ["--initiative", options.initiative] : []),
    ...(options.branchPrefix ? ["--branch-prefix", options.branchPrefix] : []),
    ...(hotfix
      ? [
          "--hotfix-incident",
          options.hotfixIncident!,
          "--hotfix-approval",
          options.hotfixApproval!,
        ]
      : []),
  ];
  const preview = run(args, cwd).data;
  verifyStart(preview, expected, id, options);
  // Wood rechecks live release, mapping and claim state under its lock on apply.
  const started = run([...args, "--apply"], cwd).data;
  const { session, plan } = verifyStart(started, expected, id, options);
  return {
    id,
    owner: options.owner,
    worktree: String(session.worktree),
    branch: String(session.branch),
    branching: plan,
    sessionFile: String(started.session_file),
    goal: implementation.goal,
    acceptanceCriteria: criteria as string[],
    nextAction: session.next_action,
  };
}

export function storyPrompt(story: ReturnType<typeof prepareStory>) {
  return [
    `Active Wood Story #${story.id}. Owner: ${story.owner}. Branch: ${story.branch}.`,
    `Working directory: ${story.worktree}. Durable session: ${story.sessionFile}.`,
    `Strategy: ${story.branching.strategy}. Base: ${story.branching.base_branch}. PR target: ${story.branching.target_branch}. Planning release: ${story.branching.release_id ?? "not branch-mapped (trunk)"}.`,
    ...(story.branching.mode === "hotfix"
      ? [
          `Emergency hotfix. Incident: ${story.branching.hotfix_incident}. Approval reference: ${story.branching.hotfix_approval}. Protected-main PR and CI remain required. Reconcile main into ${story.branching.integration_branch} and verify wood repo release-readiness before subsequent release integration.`,
        ]
      : []),
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
