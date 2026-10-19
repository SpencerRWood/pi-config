import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import usageExtension from "../extensions/usage.ts";
import { USAGE_EVENT, readUsage, storyUsage, usageRow } from "../lib/usage.ts";
import { liveUsage } from "../lib/usage-display.ts";

test("background children never register a second ambient usage recorder", () => {
  const previous = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    usageExtension(
      new Proxy(
        {},
        {
          get() {
            throw new Error("Child recorder must not register");
          },
        },
      ) as ExtensionAPI,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  }
});

test("real event flow persists main, child and reviewer usage once across reloads and cumulative snapshots", async () => {
  const home = mkdtempSync(join(tmpdir(), "wood-usage-extension-"));
  const oldHome = process.env.PI_CODING_AGENT_DIR,
    oldStory = process.env.WOOD_PI_STORY_ID;
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.WOOD_PI_STORY_ID = "538";
  type Handler = (event: never, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const bus = new Map<string, (event: unknown) => void>();
  let childTokens = 20,
    unresolved = 0,
    rpcRequests = 0;
  const entries: unknown[] = [
    {
      type: "message",
      id: "historical",
      message: { role: "assistant", usage: { totalTokens: 99999 } },
    },
  ];
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: () => {},
    events: {
      on: (event: string, handler: (event: unknown) => void) => {
        bus.set(event, handler);
        return () => bus.delete(event);
      },
      emit: (event: string, raw: unknown) => {
        if (event === "subagents:rpc:v1:request") {
          const request = raw as { requestId: string; method: string };
          assert.equal(request.method, "cost");
          rpcRequests++;
          bus.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({
            version: 1,
            success: true,
            data: {
              version: 1,
              parent: { totalTokens: 1000000 },
              children: [
                {
                  runId: "run-1",
                  usage: {
                    input: childTokens,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: 0,
                  },
                },
              ],
              unresolvedAsyncChildren: unresolved,
            },
          });
        } else bus.get(event)?.(raw);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: {
      getSessionId: () => "session",
      getEntries: () => entries,
    },
    modelRegistry: {
      find: () => ({
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }),
    },
    getContextUsage: () => ({
      percent: 12,
      tokens: 1200,
      contextWindow: 10000,
    }),
    model: { provider: "coding", id: "coder" },
    ui: { setStatus: () => {} },
  } as unknown as ExtensionContext;
  const fire = async (name: string) => handlers.get(name)!({} as never, ctx);
  try {
    usageExtension(api);
    await fire("session_start");
    entries.push({
      type: "message",
      id: "new-message",
      message: {
        role: "assistant",
        provider: "coding",
        model: "coder",
        usage: {
          input: 80,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 100,
          cost: { total: 0.01 },
        },
      },
    });
    await fire("turn_end");
    const review = usageRow(
      "review-id",
      "reviewer",
      "review",
      "reviewer",
      { totalTokens: 5, cost: { total: 0.001 } },
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    );
    api.events.emit(USAGE_EVENT, { session: "other", row: review });
    api.events.emit(USAGE_EVENT, { session: "session", row: review });
    api.events.emit(USAGE_EVENT, { session: "session", row: review });
    await fire("agent_settled");
    await fire("agent_settled");
    let report = storyUsage(readUsage(home), 538);
    assert.equal(report.total.tokens.total, 125);
    assert.equal(report.total.records, 3);
    assert.equal(report.sessions[0].contextPercent, 12);
    assert.equal(report.sessions[0].contextTokens, 1200);
    assert.equal(report.sessions[0].contextProvider, "coding");
    assert.equal(report.sessions[0].contextModel, "coder");
    assert.equal(report.byRole.main.tokens.total, 100);
    assert.equal(report.byRole.reviewer.tokens.total, 5);
    assert.equal(report.total.costUsd.total, null); // RPC cost=0 lacks pricing authority.
    assert.deepEqual(liveUsage("session"), {
      session: "session",
      ...report.sessions[0].footer,
    });
    assert.equal(liveUsage("other"), undefined);
    await fire("session_start"); // reload sees the same transcript; no double charge.
    childTokens = 40;
    unresolved = 1;
    await fire("agent_settled");
    report = storyUsage(readUsage(home), 538);
    assert.equal(report.total.tokens.total, 145);
    assert.equal(report.childrenAvailable, false);
    assert.match(report.sessions[0].footer.tokens, /unknown/);
    assert.equal(report.total.records, 3);
    assert.equal(rpcRequests, 3);
    assert.equal(
      [...bus.keys()].filter((key) => key.startsWith("subagents:rpc:v1:reply:"))
        .length,
      0,
    );
    await fire("session_shutdown");
    assert.equal(liveUsage("session"), undefined);
  } finally {
    if (oldHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldHome;
    if (oldStory === undefined) delete process.env.WOOD_PI_STORY_ID;
    else process.env.WOOD_PI_STORY_ID = oldStory;
    rmSync(home, { recursive: true, force: true });
  }
});
