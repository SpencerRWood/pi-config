import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const extensionEntries = [
  "@gotgenes/pi-permission-system/src/index.ts",
  "@narumitw/pi-plan-mode/dist/index.ts",
  "@narumitw/pi-lsp/dist/index.ts",
  "pi-subagents/index.js",
] as const;

export function createSettings(repo: string, shared: string) {
  return {
    packages: [],
    extensions: [
      join(repo, "extensions/authorization.ts"),
      ...extensionEntries.map((entry) => join(repo, "node_modules", entry)),
      join(repo, "extensions/footer.ts"),
    ],
    skills: [join(shared, "skills")],
    defaultProjectTrust: "ask",
    cacheWarming: "off",
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
    subagents: { projectRootResolution: "git-root" },
  };
}

// The Wood gate runs first; this package supplies path gates and human fallback.
export const permissions = {
  permission: {
    "*": "ask",
    read: "allow",
    find: "allow",
    grep: "allow",
    ls: "allow",
    edit: "allow",
    write: "allow",
    bash: { "*": "ask" },
    path: {
      "*": "allow",
      "*.env": "ask",
      "*.env.*": "ask",
      "*/auth.json": "ask",
      "~/.ssh/*": "ask",
      "~/.aws/*": "ask",
    },
    external_directory: "ask",
  },
  yoloMode: false,
  authorizerChain: ["wood-independent-review"],
  debugLog: false,
  permissionReviewLog: false,
};

export const subagents = {
  toolActivation: "auto",
  toolDescriptionMode: "compact",
  scheduledRuns: { enabled: false },
  maxSubagentSpawnsPerRun: 4,
  maxSubagentSpawnsPerSession: 8,
  disabledFeatures: [
    "watchdog",
    "missions",
    "lane-management",
    "lane-metadata",
    "external-machines",
    "workflow-scripts",
    "spawn-budget-grants",
  ],
};

export function validateSources(repoPath: string, sharedPath: string) {
  const repo = realpathSync(resolve(repoPath));
  const shared = realpathSync(resolve(sharedPath));
  for (const file of [
    "AGENTS.md",
    "skills/openproject-development-workflow/SKILL.md",
    "skills/brief-check/SKILL.md",
    "skills/session-handoff/SKILL.md",
  ]) {
    if (!statSync(join(shared, file)).isFile())
      throw new Error(`Missing shared resource: ${file}`);
  }
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies)) {
    const installed = JSON.parse(
      readFileSync(join(repo, "node_modules", name, "package.json"), "utf8"),
    );
    if (installed.version !== manifest.dependencies[name])
      throw new Error(`Dependency pin mismatch: ${name}`);
  }
  for (const entry of extensionEntries) {
    if (!statSync(join(repo, "node_modules", entry)).isFile())
      throw new Error(`Missing extension: ${entry}`);
  }
  return { repo, shared };
}
