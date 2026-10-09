import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shellPolicy, filePolicy, toolPolicy } from "../lib/authorization.ts";
import { audit } from "../lib/authorization-audit.ts";

const root = mkdtempSync(join(tmpdir(), "wood-policy-"));
const cwd = join(root, "repository"),
  agentDir = join(root, "private-agent");
mkdirSync(cwd);
mkdirSync(agentDir, { mode: 0o700 });
after(() => rmSync(root, { recursive: true, force: true }));

test("ordinary local checks and unpublished local image builds need no reviewer", () => {
  for (const command of [
    "git status --short",
    "git diff --check",
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "uv run --frozen pytest",
    "wood repo validate --json",
    "docker build -t example:local .",
    "docker buildx build --load --platform linux/amd64 .",
    "podman build --no-cache .",
  ])
    assert.equal(shellPolicy(command).kind, "allow", command);
});

test("release and remote operations cannot be promoted to asks", () => {
  for (const command of [
    "docker push example:local",
    "docker push token=value",
    "docker buildx build --push .",
    "docker build --output type=registry .",
    "docker build --output=type=registry .",
    "docker buildx build --builder production .",
    "docker -H remote build .",
    "docker context use production",
    "docker inspect running-container",
    "podman push local",
    "docker build https://github.com/example/project",
    "terraform apply",
    "tofu apply",
    "ansible-playbook -i dev site.yml",
    "kubectl apply -f service.yml",
    "helm upgrade service chart",
    "aws ecr put-image",
    "ssh host deploy",
    "sudo /usr/local/sbin/deploy repo apply",
    "gh workflow run deploy.yml",
    "gh release create v1.0.0",
    "npm publish",
    "git tag v1.0.0",
    "rclone copy local drive:root",
    "curl -X POST endpoint",
  ])
    assert.equal(shellPolicy(command).kind, "deny", command);
});

test("shell and command wrapper bypasses are denied before review or human approval", () => {
  for (const command of [
    "env docker push image",
    "TOKEN=value bash -c deploy",
    "command docker push image",
    "timeout 10 docker push image",
    "/usr/bin/docker push image",
    "bash -c 'docker push image'",
    "sh script.sh",
    "node -e 'deploy()'",
    "python3 deploy.py",
    "npm run deploy",
    "make deploy",
    "./deploy.sh",
    "git status; docker push image",
    "git status && docker push image",
    "git status | sh",
    "git status > /tmp/output",
    "git status\ndocker push image",
    'git status "$(docker push image)"',
    "git status `deploy`",
    "g\\it status",
    "git -c alias.status=deploy status",
    "docker build --secret id=token .",
    "docker build --ssh default .",
  ])
    assert.equal(shellPolicy(command).kind, "deny", command);
});

test("sensitive mutations stay human-only, narrow diagnostics alone are reviewable", () => {
  for (const command of [
    "git commit -m 'policy change'",
    "git push origin branch",
    "git reset --hard",
    "rm -rf generated",
    "wood story complete 535 --apply --json",
  ])
    assert.equal(shellPolicy(command).kind, "human", command);
  for (const command of [
    "docker image inspect example:local",
    "gh pr view 42",
    "gh run view 123",
  ])
    assert.equal(shellPolicy(command).kind, "review", command);
  assert.equal(
    toolPolicy("mcp_google_drive_create_file", {}, cwd, agentDir).kind,
    "human",
  );
  for (const tool of [
    "exec_command",
    "powershell",
    "subagent",
    "lsp_fix",
    "mcp",
    "codemode",
    "deploy_infrastructure",
  ])
    assert.equal(toolPolicy(tool, {}, cwd, agentDir).kind, "deny", tool);
});

test("file boundaries resolve symlinks and missing descendants; runtime policy is protected", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(cwd, "escape"));
  symlinkSync(agentDir, join(cwd, "runtime"));
  symlinkSync(join(root, ".env"), join(cwd, "dangling-secret"));
  assert.equal(filePolicy("src/new.ts", cwd, agentDir).kind, "allow");
  assert.equal(filePolicy("escape/new.ts", cwd, agentDir).kind, "human");
  assert.equal(filePolicy("../outside/file", cwd, agentDir).kind, "human");
  assert.equal(filePolicy("runtime/settings.json", cwd, agentDir).kind, "deny");
  assert.equal(filePolicy(".env", cwd, agentDir).kind, "human");
  assert.equal(filePolicy("dangling-secret", cwd, agentDir).kind, "deny");
});

test("audit is private, appendable, input-free, and refuses symlinks or unsafe modes", () => {
  audit(agentDir, {
    phase: "policy",
    result: "deny",
    reason: "release-or-remote-operation",
  });
  audit(agentDir, {
    phase: "reviewer",
    result: "defer",
    reason: "reviewer-failed",
    reviewerCalls: 1,
  });
  const path = join(agentDir, "wood-authorization/decisions.jsonl");
  const records = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.notEqual(records[0].id, records[1].id);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(
    Object.keys(records[0]).sort(),
    ["schemaVersion", "observedAt", "id", "phase", "result", "reason"].sort(),
  );
  rmSync(path);
  const target = join(root, "untouched");
  writeFileSync(target, "private", { mode: 0o600 });
  symlinkSync(target, path);
  assert.throws(() =>
    audit(agentDir, { phase: "policy", result: "allow", reason: "local-file" }),
  );
  assert.equal(readFileSync(target, "utf8"), "private");
});
