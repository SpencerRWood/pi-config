import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import milestones from "../extensions/milestones.ts";
import { milestoneTrigger, reportMilestones } from "../lib/milestones.ts";
import type { WoodRunner } from "../lib/story.ts";

function runner() {
  const calls: string[][] = [];
  let fail = false;
  const run: WoodRunner = (args, cwd) => {
    assert.equal(cwd, "/repository");
    calls.push(args);
    if (fail && args.includes("--apply")) throw new Error("private failure");
    return {
      schema_version: 2,
      status: "success",
      summary: "Reported",
      requires_approval: false,
      data:
        args[0] === "contract"
          ? { capabilities: ["story milestones"], milestones: { version: 1 } }
          : { pending_count: 0 },
    };
  };
  return {
    calls,
    run,
    fail: () => {
      fail = true;
    },
  };
}

test("milestones delegate preview/apply with explicit selectors and no model invocation", () => {
  const { run, calls } = runner();
  reportMilestones(
    {
      story: "42",
      owner: "pi-1",
      validation: "/checks/validation.json",
      pr: 7,
    },
    "/repository",
    run,
  );
  assert.deepEqual(calls[0], [
    "story",
    "milestones",
    "42",
    "--owner",
    "pi-1",
    "--validation",
    "/checks/validation.json",
    "--pr",
    "7",
  ]);
  assert.deepEqual(calls[1], [...calls[0]!, "--apply"]);
  assert.throws(
    () =>
      reportMilestones(
        { story: "42", owner: "pi-1", retry: true, pr: 7 },
        "/repository",
        run,
      ),
    /Invalid milestone/,
  );
  assert.throws(
    () =>
      reportMilestones(
        { story: "42", owner: "pi-1", validation: "relative" },
        "/repository",
        run,
      ),
    /Invalid milestone/,
  );
  assert.equal(calls.length, 2);
});

test("tool output supplies only a trigger; Wood must reverify source and authorities", () => {
  const envelope = JSON.stringify({
    schema_version: 2,
    command: "repo validate",
    status: "success",
    data: { passed: true, validation_file: "/record.json" },
  });
  assert.deepEqual(milestoneTrigger("wood repo validate --json", [envelope]), {
    validation: "/record.json",
  });
  assert.deepEqual(
    milestoneTrigger("uv run --active --frozen wood repo validate --json", [
      envelope,
    ]),
    { validation: "/record.json" },
  );
  assert.equal(milestoneTrigger("cat untrusted.txt", [envelope]), undefined);
  assert.equal(
    milestoneTrigger("wood repo validate --json", ["not JSON"]),
    undefined,
  );
  assert.deepEqual(
    milestoneTrigger("gh pr create --base development", [
      "https://github.com/owner/repo/pull/77",
    ]),
    { pr: 77 },
  );
  assert.deepEqual(milestoneTrigger("gh pr checks 77", []), { pr: 77 });
  assert.equal(milestoneTrigger("gh pr checks", []), undefined);
});

test("extension reports explicit Story events and retries without injecting messages or model calls", async () => {
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  let command: (args: string, ctx: any) => Promise<void>;
  const api = {
    on: (name: string, hook: any) => hooks.set(name, hook),
    registerCommand: (_name: string, options: any) => {
      command = options.handler;
    },
  } as unknown as ExtensionAPI;
  const { run, calls, fail } = runner();
  milestones(api, run);
  const statuses: string[] = [],
    messages: string[] = [];
  const ctx = {
    cwd: "/repository",
    ui: {
      setStatus: (_key: string, text: string) => statuses.push(text),
      notify: (text: string) => messages.push(text),
    },
  } as unknown as ExtensionContext;
  const previous = {
    story: process.env.WOOD_PI_STORY_ID,
    owner: process.env.WOOD_PI_STORY_OWNER,
  };
  try {
    delete process.env.WOOD_PI_STORY_ID;
    delete process.env.WOOD_PI_STORY_OWNER;
    hooks.get("session_start")!({}, ctx);
    assert.equal(calls.length, 0);
    process.env.WOOD_PI_STORY_ID = "42";
    process.env.WOOD_PI_STORY_OWNER = "pi-1";
    hooks.get("session_start")!({}, ctx);
    assert.equal(calls.length, 3);
    assert.equal(statuses.at(-1), "milestones:reported");
    const event = {
      toolName: "bash",
      isError: false,
      input: { command: "gh pr checks 7" },
      content: [],
    };
    hooks.get("tool_result")!({ ...event, isError: true }, ctx);
    hooks.get("tool_result")!({ ...event, parentToolCallId: "child" }, ctx);
    assert.equal(calls.length, 3);
    hooks.get("tool_result")!(event, ctx);
    assert.equal(calls.length, 5);
    assert.equal(messages.length, 0);
    await command!("retry", ctx);
    assert.ok(calls.at(-1)!.includes("--retry"));
    fail();
    hooks.get("tool_result")!(event, ctx);
    assert.equal(statuses.at(-1), "milestones:pending");
    await command!('{"owner":"other"}', ctx);
    assert.equal(statuses.at(-1), "milestones:pending");
    assert.ok(messages.every((text) => !text.includes("private failure")));
  } finally {
    for (const [name, value] of [
      ["WOOD_PI_STORY_ID", previous.story],
      ["WOOD_PI_STORY_OWNER", previous.owner],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
