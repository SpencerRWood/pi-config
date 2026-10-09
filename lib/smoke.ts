import assert from "node:assert/strict";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { verifyInstallation } from "./install.ts";

export async function smoke(agentDir: string, cwd: string) {
  const { shared } = verifyInstallation(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, {
      projectTrusted: false,
    }),
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(
    loaded.errors,
    [],
    "Pinned extensions must load with the real Pi loader",
  );
  const commands = new Set(
    loaded.extensions.flatMap((e) => [...e.commands.keys()]),
  );
  const tools = new Set(loaded.extensions.flatMap((e) => [...e.tools.keys()]));
  for (const command of [
    "plan",
    "lsp",
    "permission-system",
    "wood-footer-refresh",
  ])
    assert.ok(commands.has(command), `Missing command: ${command}`);
  for (const tool of ["lsp_diagnostics", "lsp_fix", "subagent"])
    assert.ok(tools.has(tool), `Missing tool: ${tool}`);
  assert.ok(
    loaded.extensions.some((e) =>
      e.path.endsWith("extensions/authorization.ts"),
    ),
    "Wood authorization extension must register successfully",
  );
  assert.ok(
    loader
      .getAgentsFiles()
      .agentsFiles.some((a) => a.content.includes("Shared")),
    "Canonical shared policy must load",
  );
  assert.ok(
    loader
      .getSkills()
      .skills.some((s) => s.name === "openproject-development-workflow"),
    "Shared workflow skill must be discoverable",
  );
  assert.ok(
    loader.getSkills().skills.every((s) => s.filePath.startsWith(shared)),
    "Only explicit shared skills should be installed",
  );
  return {
    extensions: loaded.extensions.length,
    commands: ["plan", "lsp", "permission-system", "wood-footer-refresh"],
    tools: ["lsp_diagnostics", "lsp_fix", "subagent"],
    sharedSkills: loader.getSkills().skills.length,
    modelCalls: 0,
    scope:
      "resource loading and registration; no provider requests or child agents",
  };
}
