import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareStory,
  runWood,
  storyPrompt,
  type WoodRunner,
} from "../lib/story.ts";

const temporary = mkdtempSync(join(tmpdir(), "wood-pi-story-"));
after(() => rmSync(temporary, { recursive: true, force: true }));

const options = {
  story: "next",
  owner: "pi-session-1",
  worktree: "/private/tmp/story-42",
};
const capabilities = [
  "story next",
  "story get",
  "story start",
  "story session get",
  "story session checkpoint",
  "story session handoff",
  "story session release",
  "repo branching",
];

const branchingContract = {
  version: 1,
  strategies: ["trunk", "release", "integration"],
  branch_prefixes: ["feature", "feat", "fix"],
  hotfix: { version: 1 },
};
const trunk = {
  strategy: "trunk",
  adopted: false,
  base_branch: "main",
  target_branch: "main",
};
const resolved = {
  ...trunk,
  base_ref: "refs/heads/main",
  base_revision: "a".repeat(40),
};

function runner(overrides: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const run: WoodRunner = (args, cwd) => {
    assert.equal(cwd, "/repository");
    calls.push(args);
    const command = args.slice(0, args[0] === "contract" ? 1 : 2).join(" ");
    const data = {
      contract: { capabilities, branching: branchingContract },
      "repo branching": trunk,
      "story next": { story: { id: 42 } },
      "story get": {
        implementation: {
          goal: "Ship lifecycle",
          acceptance_criteria: ["Isolate worktrees"],
        },
      },
      "story start": {
        branching: resolved,
        session: {
          branching: resolved,
          story_id: 42,
          owner: options.owner,
          state: "claimed",
          worktree: options.worktree,
          branch: "feature/op-42-ship-lifecycle",
          next_action: "Implement the Story",
        },
        worktree: {
          path: options.worktree,
          branch: "feature/op-42-ship-lifecycle",
          base_revision: resolved.base_revision,
        },
        session_file: "/repository/.git/wood-stories/42.json",
      },
      ...overrides,
    }[command];
    return {
      schema_version: 2,
      status: "success",
      summary: "Fixture",
      requires_approval: false,
      data: data as Record<string, unknown>,
    };
  };
  return { calls, run };
}

test("Pi selects and reads criteria, previews and applies Wood start without another lifecycle client", () => {
  const { run, calls } = runner();
  const result = prepareStory(options, "/repository", run);
  assert.equal(result.id, 42);
  assert.equal(result.worktree, options.worktree);
  assert.deepEqual(calls, [
    ["contract"],
    ["repo", "branching"],
    ["story", "next"],
    ["story", "get", "42"],
    [
      "story",
      "start",
      "42",
      "--owner",
      options.owner,
      "--worktree",
      options.worktree,
      "--base-branch",
      "main",
      "--target-branch",
      "main",
    ],
    [
      "story",
      "start",
      "42",
      "--owner",
      options.owner,
      "--worktree",
      options.worktree,
      "--base-branch",
      "main",
      "--target-branch",
      "main",
      "--apply",
    ],
  ]);
  const prompt = storyPrompt(result);
  assert.match(prompt, /openproject-development-workflow/);
  assert.match(prompt, /Stop before commit\/push\/PR creation/);
  assert.match(prompt, /Keep the claim on exit/);
  assert.match(prompt, /references, not passed validation/);
});

test("explicit Story skips discovery and Initiative override flows to Wood", () => {
  const { run, calls } = runner();
  prepareStory(
    { ...options, story: "42", initiative: "10" },
    "/repository",
    run,
  );
  assert.equal(
    calls.some((args) => args[1] === "next"),
    false,
  );
  assert.deepEqual(calls.at(-1)?.slice(-3), ["--initiative", "10", "--apply"]);
});

test("all declared strategies and supported prefixes bind before activation", () => {
  for (const strategy of ["undeclared", "trunk", "release", "integration"]) {
    for (const prefix of ["feature", "feat", "fix"]) {
      const base =
        strategy === "release"
          ? "release/v1.2.3"
          : strategy === "integration"
            ? "development"
            : "main";
      const plan = {
        strategy: strategy === "undeclared" ? "trunk" : strategy,
        adopted: strategy !== "undeclared",
        base_branch: base,
        target_branch: base,
        ...(base === "main"
          ? {}
          : { release_id: 20, scope_reference: "approved scope" }),
      };
      const startedPlan = {
        ...plan,
        base_ref:
          base === "main" ? "refs/heads/main" : `refs/remotes/origin/${base}`,
        base_revision: "b".repeat(40),
      };
      const branch = `${prefix}/op-42-fixture`;
      const binding = {
        branching: startedPlan,
        session: {
          story_id: 42,
          owner: options.owner,
          state: "claimed",
          worktree: options.worktree,
          branch,
          branching: startedPlan,
        },
        worktree: { path: options.worktree, branch, reused: true },
        session_file: "/repository/.git/wood-stories/42.json",
      };
      const { run, calls } = runner({
        "repo branching": plan,
        "story start": binding,
      });
      const result = prepareStory(options, "/repository", run);
      assert.equal(result.branch, branch);
      assert.equal(result.branching.target_branch, base);
      assert.match(storyPrompt(result), new RegExp(`PR target: ${base}`));
      const activation = calls.at(-1)!;
      assert.equal(activation[activation.indexOf("--base-branch") + 1], base);
      assert.equal(activation[activation.indexOf("--target-branch") + 1], base);
    }
  }
});

test("session-only and incompatible branching contracts stop before discovery", () => {
  for (const branching of [
    undefined,
    { ...branchingContract, version: 2 },
    { ...branchingContract, strategies: ["trunk"] },
    { ...branchingContract, branch_prefixes: ["feature"] },
  ]) {
    const { run, calls } = runner({ contract: { capabilities, branching } });
    assert.throws(() => prepareStory(options, "/repository", run));
    assert.equal(calls.length, 1);
  }
});

test("invalid or mismatched preview plans never activate claims", () => {
  for (const field of [
    "strategy",
    "base_branch",
    "target_branch",
    "adopted",
    "release_id",
    "scope_reference",
    "base_revision",
    "base_ref",
  ]) {
    const { run, calls } = runner();
    assert.throws(() =>
      prepareStory(options, "/repository", (args, cwd) => {
        const result = run(args, cwd);
        if (args[1] === "start") {
          result.data.branching = { ...resolved, [field]: "mismatched" };
        }
        return result;
      }),
    );
    assert.equal(
      calls.some((args) => args.includes("--apply")),
      false,
    );
  }
  for (const plan of [
    { ...trunk, target_branch: "development" },
    { ...trunk, strategy: "integration" },
    { ...trunk, strategy: "release", adopted: true },
  ]) {
    const { run, calls } = runner({ "repo branching": plan });
    assert.throws(() => prepareStory(options, "/repository", run));
    assert.equal(
      calls.some((args) => args[1] === "start"),
      false,
    );
  }
});

test("explicit prefixes are checked before activation and forwarded to Wood", () => {
  for (const prefix of ["feature", "feat", "fix"]) {
    const { run, calls } = runner();
    const result = prepareStory(
      { ...options, branchPrefix: prefix },
      "/repository",
      (args, cwd) => {
        const result = run(args, cwd);
        if (args[1] === "start") {
          const branch = `${prefix}/op-42-fixture`;
          (result.data.session as Record<string, unknown>).branch = branch;
          (result.data.worktree as Record<string, unknown>).branch = branch;
        }
        return result;
      },
    );
    assert.ok(result.branch.startsWith(prefix + "/"));
    const applied = calls.at(-1)!;
    assert.equal(applied[applied.indexOf("--branch-prefix") + 1], prefix);
  }
  const { run, calls } = runner();
  assert.throws(() =>
    prepareStory({ ...options, branchPrefix: "hotfix" }, "/repository", run),
  );
  assert.equal(calls.length, 0);
});

test("hotfix requires explicit incident authority and main preview binding", () => {
  const declared = {
    strategy: "integration",
    adopted: true,
    base_branch: "development",
    target_branch: "development",
    release_id: 20,
    scope_reference: "approved R1",
  };
  const plan = {
    ...declared,
    mode: "hotfix",
    base_branch: "main",
    target_branch: "main",
    integration_branch: "development",
    hotfix_incident: "INC-42",
    hotfix_approval: "approval-7",
    base_ref: "refs/remotes/origin/main",
    base_revision: "a".repeat(40),
  };
  const binding = {
    branching: plan,
    session: {
      story_id: 42,
      owner: options.owner,
      state: "claimed",
      worktree: options.worktree,
      branch: "fix/op-42-incident",
      branching: plan,
    },
    worktree: {
      path: options.worktree,
      branch: "fix/op-42-incident",
      base_revision: plan.base_revision,
    },
    session_file: "/repository/.git/wood-stories/42.json",
  };
  const opts = {
    ...options,
    story: "42",
    hotfixIncident: "INC-42",
    hotfixApproval: "approval-7",
  };
  const { run, calls } = runner({
    "repo branching": declared,
    "story start": binding,
  });
  const result = prepareStory(opts, "/repository", run);
  assert.equal(result.branching.mode, "hotfix");
  assert.match(storyPrompt(result), /Protected-main PR and CI remain required/);
  assert.ok(calls.at(-1)!.includes("--hotfix-approval"));
  assert.ok(calls.at(-1)!.includes("approval-7"));
  for (const invalid of [
    { ...opts, story: "next" },
    { ...opts, hotfixIncident: undefined },
    { ...opts, hotfixApproval: undefined },
    { ...opts, hotfixApproval: " " },
  ]) {
    const { run, calls } = runner({
      "repo branching": declared,
      "story start": binding,
    });
    assert.throws(() => prepareStory(invalid, "/repository", run));
    assert.equal(
      calls.some((args) => args.includes("--apply")),
      false,
    );
  }
  for (const key of [
    "hotfix_incident",
    "hotfix_approval",
    "integration_branch",
    "mode",
  ]) {
    const { run, calls } = runner({
      "repo branching": declared,
      "story start": binding,
    });
    assert.throws(() =>
      prepareStory(opts, "/repository", (args, cwd) => {
        const result = run(args, cwd);
        if (args[1] === "start")
          result.data.branching = { ...plan, [key]: "changed" };
        return result;
      }),
    );
    assert.equal(
      calls.some((args) => args.includes("--apply")),
      false,
    );
  }
});

test("scope drift after preview stops launch and retains Wood recovery identity", () => {
  const { run, calls } = runner();
  assert.throws(
    () =>
      prepareStory(options, "/repository", (args, cwd) => {
        const result = run(args, cwd);
        if (args.includes("--apply")) {
          result.data.branching = { ...resolved, scope_reference: "changed" };
        }
        return result;
      }),
    /inspect its local claim/,
  );
  assert.equal(calls.filter((args) => args.includes("--apply")).length, 1);
  assert.equal(
    calls.some((args) => args[2] === "release"),
    false,
  );
});

test("old Wood contract and missing Story criteria stop before activation", () => {
  for (const overrides of [
    { contract: { capabilities: ["story next", "story start"] } },
    {
      "story get": {
        implementation: { goal: "Ship lifecycle", acceptance_criteria: [] },
      },
    },
    { "story next": { story: { id: 0 } } },
  ]) {
    const { run, calls } = runner(overrides);
    assert.throws(() => prepareStory(options, "/repository", run));
    assert.equal(
      calls.some((args) => args.includes("--apply")),
      false,
    );
  }
});

test("preview conflict prevents activation and binding mismatch prevents Pi launch", () => {
  const { run, calls } = runner();
  assert.throws(
    () =>
      prepareStory(options, "/repository", (args, cwd) => {
        if (args[1] === "start")
          throw new Error("Wood blocked: claim conflict");
        return run(args, cwd);
      }),
    /claim conflict/,
  );
  assert.equal(
    calls.some((args) => args.includes("--apply")),
    false,
  );
  const altered = runner({
    "story start": { session: { story_id: 99 }, worktree: {} },
  });
  assert.throws(
    () => prepareStory(options, "/repository", altered.run),
    /mismatched|incomplete/,
  );
});

test("malformed selectors fail before executing Wood", () => {
  for (const altered of [
    { worktree: "relative" },
    { owner: "bad owner" },
    { story: "-1" },
    { initiative: "name" },
    { story: "9007199254740992" },
  ]) {
    const { run, calls } = runner();
    assert.throws(() =>
      prepareStory({ ...options, ...altered }, "/repository", run),
    );
    assert.equal(
      calls.some((args) => args.includes("--apply")),
      false,
    );
  }
});

test("real Wood process adapter rejects failed, approval-required, malformed and oversized output", () => {
  const bin = join(temporary, "bin");
  mkdirSync(bin);
  const path = join(bin, "wood");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    const write = (code: string) =>
      writeFileSync(path, `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
    write(
      `process.stdout.write(JSON.stringify({schema_version:2,status:'success',summary:'Fixture',requires_approval:false,data:{}}));`,
    );
    assert.deepEqual(runWood(["contract"], temporary).data, {});
    write(
      `process.stdout.write(JSON.stringify({schema_version:2,status:'blocked',summary:'Claim held',requires_approval:false,data:{}}));process.exitCode=3;`,
    );
    assert.throws(
      () => runWood(["contract"], temporary),
      /blocked: Claim held/,
    );
    write(
      `process.stdout.write(JSON.stringify({schema_version:2,status:'success',summary:'Review',requires_approval:true,data:{}}));`,
    );
    assert.throws(() => runWood(["contract"], temporary), /Review/);
    write(`process.stdout.write('invalid');`);
    assert.throws(() => runWood(["contract"], temporary), /invalid JSON/);
    write(
      `process.stderr.write('fixture-private-diagnostic');process.exitCode=1;`,
    );
    assert.throws(() => runWood(["contract"], temporary), /Wood unavailable/);
    write(`process.stdout.write('x'.repeat(2*1024*1024));`);
    assert.throws(() => runWood(["contract"], temporary));
  } finally {
    process.env.PATH = previous;
  }
});
