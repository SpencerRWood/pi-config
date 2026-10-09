import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { install, verifyInstallation } from "../lib/install.ts";
import { readSnapshot } from "../lib/telemetry.ts";
import { smoke } from "../lib/smoke.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "wood-pi-test-"));
after(() => rmSync(temporary, { recursive: true, force: true }));
const shared = join(temporary, "shared-fixture");
mkdirSync(shared);
writeFileSync(
  join(shared, "AGENTS.md"),
  "# Shared fixture policy\nNo production credentials.\n",
);
for (const name of [
  "openproject-development-workflow",
  "brief-check",
  "session-handoff",
]) {
  mkdirSync(join(shared, "skills", name), { recursive: true });
  writeFileSync(
    join(shared, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test fixture, not an authoritative skill implementation.\n---\nFixture only.\n`,
  );
}

test(
  "clean installation loads pinned extensions with the actual Pi resource loader",
  { timeout: 60_000 },
  async () => {
    const agentDir = join(temporary, "clean-agent");
    install(repo, shared, agentDir);
    assert.equal(
      realpathSync(join(agentDir, "AGENTS.md")),
      realpathSync(join(shared, "AGENTS.md")),
    );
    assert.equal(statSync(join(agentDir, "settings.json")).mode & 0o777, 0o600);
    const settings = JSON.parse(
      readFileSync(join(agentDir, "settings.json"), "utf8"),
    );
    assert.deepEqual(settings.skills, [join(realpathSync(shared), "skills")]);
    const result = await smoke(agentDir, temporary);
    assert.ok(result.extensions >= 6);
    assert.equal(result.sharedSkills, 3);
    assert.equal(result.modelCalls, 0);
    assert.throws(() => install(repo, shared, agentDir), /not empty/);
  },
);

test("missing sources, relative homes and modified configuration fail directly", () => {
  assert.throws(() => install(repo, shared, "relative"), /absolute/);
  assert.throws(
    () =>
      install(repo, join(temporary, "missing"), join(temporary, "new-agent")),
    /ENOENT/,
  );
  const agentDir = join(temporary, "modified-agent");
  install(repo, shared, agentDir);
  writeFileSync(join(agentDir, "settings.json"), "{}");
  assert.throws(() => verifyInstallation(agentDir), /Settings differ/);
});

test("missing or altered permission configuration prevents launch", () => {
  const agentDir = join(temporary, "altered-policy-agent");
  install(repo, shared, agentDir);
  const path = join(agentDir, "extensions/pi-permission-system/config.json");
  writeFileSync(path, JSON.stringify({ permission: { "*": "allow" } }));
  assert.throws(() => verifyInstallation(agentDir), /differ from/);
  rmSync(path);
  assert.throws(() => verifyInstallation(agentDir), /ENOENT/);
});

test("Story launcher hands the bound worktree to the actual pinned Pi CLI and retains its claim on exit", () => {
  const agentDir = join(temporary, "story-launch-agent");
  install(repo, shared, agentDir);
  const cwd = join(temporary, "target-repository");
  const worktree = join(temporary, "story-worktree");
  const bin = join(temporary, "story-bin");
  for (const path of [cwd, worktree, bin]) mkdirSync(path);
  const calls = join(temporary, "story-wood-calls.jsonl");
  const sessionFile = join(temporary, "42.json");
  const cliObservation = join(temporary, "pi-cli-observation.json");
  const preload = join(temporary, "observe-cli.mjs");
  writeFileSync(
    preload,
    `import { writeFileSync } from 'node:fs';
if (process.argv[1] === ${JSON.stringify(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))})
  writeFileSync(${JSON.stringify(cliObservation)}, JSON.stringify({cwd:process.cwd(),agentDir:process.env.PI_CODING_AGENT_DIR,args:process.argv.slice(2)}));\n`,
  );
  const session = {
    story_id: 42,
    owner: "pi-launch-fixture",
    state: "claimed",
    worktree,
    branch: "feature/op-42-launch",
    next_action: "Implement the Story",
  };
  // Exercise the launcher process and real Pi argument parser. Wood transport is
  // a local executable fixture: no OpenProject mutation, provider call or login.
  writeFileSync(
    join(bin, "wood"),
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, cwd: process.cwd()}) + '\\n');
const session = ${JSON.stringify(session)};
const data = args[0] === 'contract' ? {capabilities: ['story next', 'story get', 'story start', 'story session get', 'story session checkpoint', 'story session handoff', 'story session release']}
  : args[1] === 'get' ? {implementation: {goal: 'Launch in the bound worktree', acceptance_criteria: ['Keep the claim on exit']}}
  : {session, worktree: {path: session.worktree}, session_file: ${JSON.stringify(sessionFile)}};
if (args.includes('--apply')) writeFileSync(${JSON.stringify(sessionFile)}, JSON.stringify(session));
process.stdout.write(JSON.stringify({schema_version: 2, status: 'success', summary: 'Fixture', requires_approval: false, data}));
`,
    { mode: 0o700 },
  );
  const launched = spawnSync(
    process.execPath,
    [
      "--import",
      join(repo, "node_modules/tsx/dist/loader.mjs"),
      join(repo, "scripts/pi.ts"),
      "--agent-dir",
      agentDir,
      "--story",
      "42",
      "--owner",
      session.owner,
      "--worktree",
      worktree,
      "--",
      "--help",
    ],
    {
      cwd,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import="${preload}"`,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /--append-system-prompt/);
  assert.match(launched.stderr, /pi-launch-fixture/);
  assert.deepEqual(JSON.parse(readFileSync(sessionFile, "utf8")), session);
  const observed = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(observed.length, 4);
  assert.ok(observed.every((call) => call.cwd === realpathSync(cwd)));
  assert.equal(
    observed.some((call) => call.args.includes("release")),
    false,
  );
  const actualCli = JSON.parse(readFileSync(cliObservation, "utf8"));
  assert.equal(actualCli.cwd, realpathSync(worktree));
  assert.equal(actualCli.agentDir, agentDir);
  assert.ok(actualCli.args.includes("--append-system-prompt"));
});

test("telemetry reader rejects malformed, oversized and symlinked inputs", () => {
  const root = join(temporary, "telemetry");
  mkdirSync(join(root, ".pi"), { recursive: true });
  const path = join(root, ".pi/wood-footer.json");
  assert.equal(readSnapshot(root), undefined);
  writeFileSync(path, "invalid");
  assert.equal(readSnapshot(root), undefined);
  writeFileSync(path, " ".repeat(65537));
  assert.equal(readSnapshot(root), undefined);
  const valid = { schemaVersion: 1, repository: "pi-config" };
  writeFileSync(path, JSON.stringify(valid));
  assert.deepEqual(readSnapshot(root), valid);
  rmSync(path);
  const target = join(root, "outside.json");
  writeFileSync(target, JSON.stringify(valid));
  symlinkSync(target, path);
  assert.equal(readSnapshot(root), undefined);
});
