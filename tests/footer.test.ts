import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  clean,
  parseSnapshot,
  renderFooter,
  type Identity,
  type Observation,
} from "../lib/footer.ts";

const now = Date.parse("2026-10-09T12:00:00Z");
const identity: Identity = {
  repository: "pi-config",
  branch: "feature/op-533-config",
  revision: "abc",
  dirty: false,
  provider: "test-provider",
  model: "test-model",
  mode: "tui",
  contextPercent: 25,
};
const passed: Observation = {
  state: "passed",
  revision: "abc",
  source: "test authority",
  observedAt: "2026-10-09T11:59:00Z",
  expiresAt: "2026-10-09T12:01:00Z",
};

test("footer includes every required field and never infers missing telemetry", () => {
  const lines = renderFooter(identity, undefined, 240, now);
  assert.equal(lines.length, 2);
  for (const label of [
    "repo:pi-config",
    "git:feature/op-533-config",
    "op:533",
    "mode:tui",
    "model:test-model",
    "ctx:25.0%",
    "5h:unavailable",
    "week:unavailable",
    "local:unavailable",
    "ci:unavailable",
    "release:unavailable",
    "deploy:unavailable",
  ])
    assert.ok(lines.join(" ").includes(label), label);
  assert.ok(!lines.join(" ").includes("passed"));
});

test("fresh authority observations show checks and provider quota", () => {
  const snapshot = parseSnapshot({
    schemaVersion: 1,
    repository: "pi-config",
    local: passed,
    ci: passed,
    release: { ...passed, state: "blocked" },
    fiveHour: { ...passed, provider: "test-provider", remainingPercent: 42 },
  });
  const line = renderFooter(identity, snapshot, 240, now)[1];
  assert.match(line, /local:passed/);
  assert.match(line, /ci:passed/);
  assert.match(line, /5h:42%/);
  assert.match(line, /release:blocked/);
});

for (const [name, observation, current] of [
  ["expiry", { ...passed, expiresAt: "2026-10-09T12:00:00Z" }, identity],
  ["future", { ...passed, observedAt: "2026-10-09T12:00:01Z" }, identity],
  ["revision mismatch", { ...passed, revision: "other" }, identity],
  ["dirty workspace", passed, { ...identity, dirty: true }],
  ["unborn revision", passed, { ...identity, revision: "" }],
] as const) {
  test(`${name} cannot present a passing observation`, () => {
    const snapshot = parseSnapshot({
      schemaVersion: 1,
      repository: "pi-config",
      local: observation,
    });
    const line = renderFooter(current, snapshot, 240, now)[1];
    assert.match(line, /local:stale/);
    assert.ok(!line.includes("passed"));
  });
}

test("foreign repository, provider and missing quota values are unavailable", () => {
  const snapshot = parseSnapshot({
    schemaVersion: 1,
    repository: "foreign",
    local: passed,
  });
  assert.match(
    renderFooter(identity, snapshot, 240, now)[1],
    /local:unavailable/,
  );
  for (const quota of [
    { ...passed, provider: "other", remainingPercent: 50 },
    { ...passed, provider: "test-provider" },
  ]) {
    assert.match(
      renderFooter(
        identity,
        parseSnapshot({
          schemaVersion: 1,
          repository: "pi-config",
          weekly: quota,
        }),
        240,
        now,
      )[1],
      /week:unavailable/,
    );
  }
});

test("malformed or unsupported observations fail closed", () => {
  for (const value of [
    null,
    [],
    {},
    { schemaVersion: 2, repository: "pi-config" },
    ...[
      { ...passed, state: "success" },
      { ...passed, source: "" },
      { ...passed, observedAt: "invalid" },
      { ...passed, expiresAt: "2026-11-09T12:00:00Z" },
    ].map((local) => ({ schemaVersion: 1, repository: "pi-config", local })),
  ])
    assert.equal(parseSnapshot(value), undefined);
  for (const remainingPercent of [-1, 101, NaN, "100"])
    assert.equal(
      parseSnapshot({
        schemaVersion: 1,
        repository: "pi-config",
        weekly: { ...passed, provider: "test-provider", remainingPercent },
      }),
      undefined,
    );
});

test("compact two-line rendering is bounded and terminal-safe", () => {
  const unsafe = {
    ...identity,
    repository: "仓库".repeat(30),
    model: "\x1b[31mMODEL\n\x1b]0;bad\x07",
    branch: "main",
    contextPercent: null,
  };
  for (const width of [0, 20, 60, 80, 120, 240]) {
    const lines = renderFooter(unsafe, undefined, width, now);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width);
      assert.ok(!/[\x00-\x1f\x7f]/.test(line));
    }
  }
  const lines = renderFooter(identity, undefined, 80, now);
  for (const label of ["5h:", "week:", "local:", "ci:", "release:", "deploy:"])
    assert.ok(lines[1].includes(label));
  assert.equal(clean("foo\u202ebar"), "foobar");
  assert.match(renderFooter(unsafe, undefined, 240, now)[0], /op:unbound/);
});
