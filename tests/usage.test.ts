import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  digest,
  loadUsage,
  readUsage,
  saveUsage,
  storyUsage,
  usageDisplay,
  usageRow,
  observedUsage,
} from "../lib/usage.ts";
import { renderFooter } from "../lib/footer.ts";

const temporary = mkdtempSync(join(tmpdir(), "wood-usage-test-"));
after(() => rmSync(temporary, { recursive: true, force: true }));
const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
const usage = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { total: 0.001 },
};

test("unknown and zero-price usage is explicit; cache and reasoning tokens are never double-counted", () => {
  const absent = storyUsage([], 538);
  assert.equal(absent.available, false);
  assert.equal(absent.total.tokens.total, null);
  assert.equal(absent.total.costUsd.total, null);
  const unknown = usageRow("unknown", "reviewer", "provider", "model", {});
  assert.equal(unknown.totalTokens, null);
  assert.equal(unknown.costUsd, null);
  const zero = usageRow(
    "zero",
    "main",
    "provider",
    "model",
    { ...usage, cost: { total: 0 } },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  assert.equal(zero.costUsd, null);
  assert.equal(zero.reportedCostUsd, 0);
  const valid = usageRow(
    "known",
    "main",
    "provider",
    "model",
    { ...usage, reasoning: 10 },
    rates,
  );
  assert.equal(valid.totalTokens, 150);
  assert.equal(valid.costUsd, 0.001);
  assert.equal(valid.pricing, "pi-model-registry-estimate");
  const malformed = usageRow(
    "invalid",
    "main",
    "\x1b[31mSECRET",
    "model",
    { input: NaN, output: -1, cost: { total: Infinity } },
    rates,
  );
  assert.equal(malformed.provider, "unavailable");
  assert.equal(malformed.totalTokens, null);
  assert.equal(malformed.costUsd, null);
  const failed = usageRow(
    "failed",
    "main",
    "provider",
    "model",
    observedUsage(
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { total: 0 },
      },
      "error",
    ),
    rates,
  );
  assert.equal(failed.totalTokens, null);
  assert.equal(failed.costUsd, null);
  assert.deepEqual(observedUsage(usage, "aborted"), usage);
});

test("durable multi-session Story report separates roles/providers and reconciles footer and CLI", () => {
  const first = loadUsage(temporary, "session-one", 538);
  first.children = "observed";
  first.unresolvedChildren = 0;
  first.contextPercent = 25;
  first.rows = [
    usageRow("main", "main", "coding", "coder", usage, rates),
    usageRow("review", "reviewer", "review", "reviewer", usage, rates),
    usageRow("child", "subagent", undefined, undefined, {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    }),
  ];
  saveUsage(temporary, first);
  const second = loadUsage(temporary, "session-two", 538);
  second.rows = [
    usageRow("failed-review", "reviewer", "review", "reviewer", {}),
  ];
  saveUsage(temporary, second);
  saveUsage(temporary, loadUsage(temporary, "foreign-story", 539));
  assert.deepEqual(loadUsage(temporary, "session-one", 538), first);
  assert.throws(
    () => loadUsage(temporary, "session-one", 539),
    /binding mismatch/,
  );
  const report = storyUsage(readUsage(temporary), 538);
  assert.equal(report.sessions.length, 2);
  assert.equal(report.byRole.main.tokens.total, 150);
  assert.equal(report.byRole.reviewer.tokens.total, null);
  assert.equal(report.byRole.reviewer.tokens.known, 150);
  assert.equal(report.byRole.subagent.tokens.total, 15);
  assert.equal(report.total.costUsd.known, 0.002);
  assert.equal(report.total.costUsd.total, null);
  assert.equal(report.complete, false);
  assert.equal(report.childrenAvailable, false);
  const display = usageDisplay(first);
  assert.deepEqual(report.sessions[0].footer, display);
  const lines = renderFooter(
    {
      repository: "repo",
      branch: "fix/op-538-usage",
      revision: "rev",
      dirty: false,
      provider: "coding",
      model: "coder",
      mode: "tui",
      contextPercent: 25,
      usage: display,
    },
    undefined,
    400,
  );
  assert.match(lines[0], /op:538/);
  assert.ok(lines[0].includes(`tok:${display.tokens}`));
  assert.ok(lines[0].includes(`cost:${display.cost}`));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/usage-report.ts",
      "--agent-dir",
      temporary,
      "--story",
      "538",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), report);
  const file = join(temporary, "wood-usage", `${digest(first.session)}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(temporary, "wood-usage")).mode & 0o777, 0o700);
  assert.doesNotMatch(readFileSync(file, "utf8"), /prompt|command|sessionFile/);
});

test("private report refuses symlink, malformed and unexpected data instead of publishing it", () => {
  const home = mkdtempSync(join(tmpdir(), "wood-usage-unsafe-"));
  try {
    const session = loadUsage(home, "unsafe", 538);
    saveUsage(home, session);
    const file = join(home, "wood-usage", `${digest(session.session)}.json`);
    writeFileSync(
      file,
      JSON.stringify({ ...session, secret: "must-not-report" }),
    );
    assert.throws(() => readUsage(home), /Invalid usage/);
    rmSync(file);
    const target = join(home, "target");
    writeFileSync(target, JSON.stringify(session), { mode: 0o600 });
    symlinkSync(target, file);
    assert.throws(() => readUsage(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.throws(() => loadUsage(process.cwd(), "session", 538), /outside/);
});
