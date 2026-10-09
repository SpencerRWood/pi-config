import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  createSettings,
  permissions,
  subagents,
  validateSources,
} from "./config.ts";

export function install(repo: string, shared: string, agentDir: string) {
  if (!isAbsolute(agentDir))
    throw new Error("--agent-dir must be an absolute path");
  const sources = validateSources(repo, shared);
  const destination = resolve(agentDir);
  if (existsSync(destination) && readdirSync(destination).length)
    throw new Error(
      "Agent directory is not empty; inspect it instead of overwriting configuration",
    );
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const write = (name: string, value: unknown) => {
    const target = join(destination, name);
    mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(target, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  };
  write("settings.json", createSettings(sources.repo, sources.shared));
  write("extensions/pi-permission-system/config.json", permissions);
  write("extensions/subagent/config.json", subagents);
  symlinkSync(
    join(sources.shared, "AGENTS.md"),
    join(destination, "AGENTS.md"),
  );
  symlinkSync(
    join(sources.repo, "docs/pi-policy.md"),
    join(destination, "APPEND_SYSTEM.md"),
  );
  write("wood-install.json", {
    schemaVersion: 1,
    ...sources,
    agentDir: destination,
  });
  return {
    ...sources,
    agentDir: destination,
    settings: join(destination, "settings.json"),
  };
}

export function verifyInstallation(agentDir: string) {
  if (!isAbsolute(agentDir))
    throw new Error("--agent-dir must be an absolute path");
  const manifest = JSON.parse(
    readFileSync(join(agentDir, "wood-install.json"), "utf8"),
  );
  if (manifest.schemaVersion !== 1 || manifest.agentDir !== resolve(agentDir))
    throw new Error(
      "Installation manifest does not match the explicit agent directory",
    );
  const sources = validateSources(manifest.repo, manifest.shared);
  for (const [file, expected] of [
    ["settings.json", createSettings(sources.repo, sources.shared)],
    ["extensions/pi-permission-system/config.json", permissions],
    ["extensions/subagent/config.json", subagents],
  ] as const) {
    const actual = JSON.parse(readFileSync(join(agentDir, file), "utf8"));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `${file === "settings.json" ? "Settings" : file} differ from the reviewed configuration; reinstall into a clean agent directory`,
      );
  }
  for (const [file, expected] of [
    ["AGENTS.md", join(sources.shared, "AGENTS.md")],
    ["APPEND_SYSTEM.md", join(sources.repo, "docs/pi-policy.md")],
  ]) {
    if (realpathSync(join(agentDir, file)) !== realpathSync(expected))
      throw new Error(`Shared policy link mismatch: ${file}`);
  }
  return sources;
}
