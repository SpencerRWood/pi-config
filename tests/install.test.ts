import assert from "node:assert/strict";
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
