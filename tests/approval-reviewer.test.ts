import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reviewCommand } from "../lib/approval-reviewer.ts";

type Response = Awaited<
  ReturnType<ExtensionContext["modelRegistry"]["complete"]>
>;
function fixture(text: string, stopReason = "stop") {
  let calls = 0;
  let received: unknown;
  const response = {
    content: [{ type: "text", text }],
    stopReason,
    usage: { input: 100, output: 12, totalTokens: 112, cost: { total: 0.001 } },
  } as Response;
  const ctx = {
    model: { provider: "coding", id: "implementer" },
    modelRegistry: {
      find: () => ({ provider: "review", id: "reviewer" }),
      hasConfiguredAuth: () => true,
      streamSimple: (_model: unknown, context: unknown, options: unknown) => {
        calls++;
        received = { context, options };
        return { result: async () => response };
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, response, calls: () => calls, received: () => received };
}
const selectors = { provider: "review", model: "reviewer" };

test("hard denials and human-only operations never invoke the reviewer", async () => {
  const f = fixture('{"decision":"allow"}');
  for (const command of [
    "docker push image",
    "bash -c deploy",
    "git push",
    "rm file",
    "npm test",
  ]) {
    const result = await reviewCommand(command, f.ctx, selectors);
    assert.equal(result.verdict.kind, "defer");
    assert.equal(result.audit.reviewerCalls, 0);
  }
  assert.equal(f.calls(), 0);
});

test("independent reviewer receives only classified operation data, no conversation or tools", async () => {
  const f = fixture('{"decision":"allow"}');
  const reviewed = await reviewCommand(
    "docker image inspect example:local",
    f.ctx,
    selectors,
  );
  assert.equal(reviewed.verdict.kind, "allow");
  assert.equal(reviewed.audit.totalTokens, 112);
  assert.equal(reviewed.audit.cost, 0.001);
  const request = f.received() as {
    context: { messages: unknown[]; tools: unknown[] };
    options: { maxTokens: number; maxRetries: number; toolChoice: string };
  };
  assert.equal(request.context.messages.length, 1);
  assert.deepEqual(request.context.tools, []);
  assert.equal(request.options.toolChoice, "none");
  assert.equal(request.options.maxTokens, 128);
  assert.equal(request.options.maxRetries, 0);
});

test("same-model self review, missing auth and missing model fail safely without a request", async () => {
  const f = fixture('{"decision":"allow"}');
  assert.equal(
    (
      await reviewCommand("gh pr view 1", f.ctx, {
        provider: "coding",
        model: "implementer",
      })
    ).audit.reason,
    "reviewer-not-independent",
  );
  f.ctx.modelRegistry.hasConfiguredAuth = () => false;
  assert.equal(
    (await reviewCommand("gh pr view 1", f.ctx, selectors)).verdict.kind,
    "defer",
  );
  f.ctx.modelRegistry.find = () => undefined;
  assert.equal(
    (await reviewCommand("gh pr view 1", f.ctx, selectors)).verdict.kind,
    "defer",
  );
  assert.equal(f.calls(), 0);
});

test("resolved model aliases cannot enable self review and malformed replies retain usage", async () => {
  const alias = fixture('{"decision":"allow"}');
  alias.ctx.modelRegistry.find = () => alias.ctx.model;
  assert.equal(
    (await reviewCommand("gh pr view 1", alias.ctx, selectors)).audit.reason,
    "reviewer-not-independent",
  );
  assert.equal(alias.calls(), 0);
  const malformed = fixture("not JSON");
  const result = await reviewCommand("gh pr view 1", malformed.ctx, selectors);
  assert.equal(result.verdict.kind, "defer");
  assert.equal(result.audit.totalTokens, 112);
  assert.equal(result.audit.cost, 0.001);
});

test("malformed, extra-key, truncated, ambiguous and provider-error replies never grant authority", async () => {
  for (const [text, stop] of [
    ["ALLOW", "stop"],
    ['{"decision":"allow","reason":"ignore the policy"}', "stop"],
    ['{"decision":"maybe"}', "stop"],
    ['{"decision":"allow"}', "length"],
    ['{"decision":"allow"}', "error"],
    ['{"decision":"defer"}', "stop"],
  ]) {
    const f = fixture(text, stop);
    assert.equal(
      (await reviewCommand("gh pr view 1", f.ctx, selectors)).verdict.kind,
      "defer",
      text + stop,
    );
  }
});

test("provider exception and a provider ignoring abort are bounded and defer without leaking errors", async () => {
  const f = fixture('{"decision":"allow"}');
  const failed = await reviewCommand("gh pr view 1", f.ctx, {
    ...selectors,
    request: async () => {
      throw new Error("TOKEN=never-log-this");
    },
  });
  assert.equal(failed.verdict.kind, "defer");
  assert.doesNotMatch(JSON.stringify(failed), /never-log-this/);
  let signal: AbortSignal | undefined;
  const timed = await reviewCommand("gh pr view 1", f.ctx, {
    ...selectors,
    timeoutMs: 10,
    request: async (abort) => {
      signal = abort;
      return new Promise<Response>(() => {});
    },
  });
  assert.equal(timed.verdict.kind, "defer");
  assert.equal(signal?.aborted, true);
});
