import assert from "node:assert/strict";
import { test, after } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import googleDrive, { driveToolNames } from "../extensions/google-drive.ts";
import { loadDriveConfig, type DriveConfig } from "../lib/drive-config.ts";
import { toolPolicy } from "../lib/authorization.ts";

const config: DriveConfig = {
  schemaVersion: 1,
  infisical: {
    configDir: "/unused",
    environment: "dev",
    path: "/pi-google-drive",
  },
  folders: {
    Projects: { id: "projects", write: true },
    Templates: { id: "templates", write: false },
    Architecture: { id: "architecture", write: false },
  },
};

const root = mkdtempSync(join(tmpdir(), "wood-drive-extension-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("runtime config rejects public files, symlinks, malformed IDs and missing approved folders", () => {
  const agent = join(root, "agent");
  const secretDirectory = join(root, "infisical");
  mkdirSync(agent, { mode: 0o700 });
  mkdirSync(secretDirectory, { mode: 0o700 });
  writeFileSync(join(secretDirectory, ".infisical.json"), "{}");
  const path = join(agent, "google-drive.json");
  const valid = {
    ...config,
    infisical: { ...config.infisical, configDir: secretDirectory },
  };
  const write = (value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write(valid);
  assert.equal(loadDriveConfig(agent).folders.Projects.id, "projects");
  chmodSync(path, 0o644);
  assert.throws(() => loadDriveConfig(agent), {
    code: "CONFIGURATION_REQUIRED",
  });
  chmodSync(path, 0o600);
  write({
    ...valid,
    folders: { ...valid.folders, Projects: { id: "root", write: true } },
  });
  assert.throws(() => loadDriveConfig(agent), {
    code: "CONFIGURATION_REQUIRED",
  });
  write({ ...valid, folders: { Projects: valid.folders.Projects } });
  assert.throws(() => loadDriveConfig(agent), {
    code: "CONFIGURATION_REQUIRED",
  });
  rmSync(path);
  const target = join(root, "elsewhere.json");
  writeFileSync(target, JSON.stringify(valid), { mode: 0o600 });
  symlinkSync(target, path);
  assert.throws(() => loadDriveConfig(agent), {
    code: "CONFIGURATION_REQUIRED",
  });
});

test("only scoped operations receive automatic policy authority; deletion and sharing retain explicit human authorization", () => {
  for (const name of driveToolNames)
    assert.equal(toolPolicy(name, {}, root, root).kind, "allow");
  for (const name of [
    "google_drive_delete_file",
    "google_drive_share_file",
    "google_drive_update_permissions",
    "google_drive_create_other",
  ])
    assert.equal(toolPolicy(name, {}, root, root).kind, "human");
  assert.equal(toolPolicy("custom_drive_delete", {}, root, root).kind, "deny");
});

test("tools register without credentials; missing configuration returns a sanitized error", async () => {
  const tools = new Map<string, any>();
  const api = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => {},
  } as unknown as ExtensionAPI;
  googleDrive(api);
  assert.equal(tools.size, 6);
  assert.equal(tools.has("google_drive_delete_file"), false);
  assert.equal(tools.has("google_drive_share_file"), false);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "not-configured");
  try {
    const result = await tools
      .get("google_drive_get")
      .execute(
        "test",
        { folder: "Projects", fileId: "existing" },
        undefined,
        undefined,
        { cwd: root },
      );
    assert.equal(result.isError, true);
    assert.equal(
      JSON.parse(result.content[0].text).code,
      "CONFIGURATION_REQUIRED",
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("upload refuses secret, external, runtime-policy and oversized paths before requesting credentials", async () => {
  const agent = join(root, "upload-agent");
  const repo = join(root, "upload-repository");
  const infisical = join(root, "upload-infisical");
  for (const directory of [agent, repo, infisical])
    mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(infisical, ".infisical.json"), "{}");
  writeFileSync(
    join(agent, "google-drive.json"),
    JSON.stringify({
      ...config,
      infisical: { ...config.infisical, configDir: infisical },
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(repo, "large.pdf"), Buffer.alloc(10 * 1024 * 1024 + 1));
  writeFileSync(join(root, "outside.pdf"), "outside");
  writeFileSync(join(repo, ".env"), "secret");
  symlinkSync(agent, join(repo, "policy"));
  const tools = new Map<string, any>();
  googleDrive({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => {},
  } as unknown as ExtensionAPI);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    for (const path of [
      ".env",
      "../outside.pdf",
      "policy/google-drive.json",
      "large.pdf",
    ]) {
      const result = await tools.get("google_drive_upload").execute(
        "test",
        {
          folder: "Projects",
          name: "artifact.pdf",
          path,
          mimeType: "application/pdf",
        },
        undefined,
        undefined,
        { cwd: repo },
      );
      assert.equal(result.isError, true);
      assert.ok(
        ["LOCAL_ARTIFACT_NOT_APPROVED", "INVALID_ARTIFACT"].includes(
          JSON.parse(result.content[0].text).code,
        ),
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
