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
];

function runner(overrides: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const run: WoodRunner = (args, cwd) => {
    assert.equal(cwd, "/repository");
    calls.push(args);
    const command = args.slice(0, args[0] === "contract" ? 1 : 2).join(" ");
    const data = {
      contract: { capabilities },
      "story next": { story: { id: 42 } },
      "story get": {
        implementation: {
          goal: "Ship lifecycle",
          acceptance_criteria: ["Isolate worktrees"],
        },
      },
      "story start": {
        session: {
          story_id: 42,
          owner: options.owner,
          state: "claimed",
          worktree: options.worktree,
          branch: "feature/op-42-ship-lifecycle",
          next_action: "Implement the Story",
        },
        worktree: { path: options.worktree },
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
    ],
    [
      "story",
      "start",
      "42",
      "--owner",
      options.owner,
      "--worktree",
      options.worktree,
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
    /mismatched/,
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
