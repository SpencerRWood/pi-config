import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type PolicyDecision = {
  kind: "allow" | "deny" | "human" | "review";
  reason: string;
};
const decision = (
  kind: PolicyDecision["kind"],
  reason: string,
): PolicyDecision => ({ kind, reason });

// Deliberately small shell language. Shell expansion, chaining, redirects,
// wrappers and interpreters cannot be approved by a model or a dialog.
export function shellWords(command: string): string[] | undefined {
  if (!command || command.length > 4096 || /[\n\r\x00]/.test(command)) return;
  const words: string[] = [];
  let word = "",
    quote = "",
    active = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else {
        if (quote === '"' && /[$`\\]/.test(char)) return;
        word += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) {
        words.push(word);
        word = "";
        active = false;
      }
    } else {
      if (/[;&|<>$`\\(){}*?~#]/.test(char)) return;
      word += char;
      active = true;
    }
  }
  if (quote) return;
  if (active) words.push(word);
  return words.length ? words : undefined;
}

function secretPath(value: string) {
  return /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|auth\.json|\.ssh|\.aws|\.secrets|\.infisical)(?:$|[/\\])/i.test(
    value,
  );
}

function canonical(path: string) {
  let ancestor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Missing path ancestor");
    suffix.unshift(relative(parent, ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

export function filePolicy(
  path: unknown,
  cwd: string,
  agentDir: string,
): PolicyDecision {
  if (typeof path !== "string" || !path || path.length > 4096)
    return decision("deny", "invalid-path");
  try {
    const target = canonical(resolve(cwd, path));
    const agent = canonical(agentDir);
    if (target === agent || target.startsWith(agent + sep))
      return decision("deny", "runtime-policy-protected");
    if (secretPath(path) || secretPath(target))
      return decision("human", "secret-access");
    const boundary = relative(realpathSync(cwd), target);
    if (
      boundary === ".." ||
      boundary.startsWith(".." + sep) ||
      isAbsolute(boundary)
    )
      return decision("human", "external-path");
    return decision("allow", "local-file");
  } catch {
    return decision("deny", "unresolved-path");
  }
}

export function shellPolicy(command: unknown): PolicyDecision {
  if (typeof command !== "string") return decision("deny", "invalid-command");
  const words = shellWords(command);
  if (!words) return decision("deny", "opaque-shell");
  const classified = classifyWords(words);
  if (
    classified.kind !== "deny" &&
    (words.some(secretPath) ||
      words.some((w) => /(?:token|password|secret|api[_-]?key)=/i.test(w)))
  )
    return decision("human", "secret-access");
  return classified;
}

function classifyWords(words: string[]): PolicyDecision {
  const [exe, ...args] = words;
  // No alternate binaries, environment assignment, command wrappers or PATH overrides.
  if (!/^[a-z][a-z0-9-]*$/.test(exe))
    return decision("deny", "opaque-executable");
  const line = words.join(" ");
  if (
    /^(?:terraform|tofu|ansible|ansible-playbook|kubectl|helm|ssh|scp|sftp|sudo|doas|aws|gcloud|az|pulumi|skopeo|crane|curl|wget|rclone|infisical|npm publish|git tag|gh release|gh workflow run|gh run rerun)\b/.test(
      line,
    )
  )
    return decision("deny", "release-or-remote-operation");
  if (exe === "docker" || exe === "podman") {
    if (
      args[0] === "build" ||
      (exe === "docker" && args[0] === "buildx" && args[1] === "build")
    ) {
      const options = args.slice(args[0] === "buildx" ? 2 : 1);
      // Only a local context and a limited flag set; remote exporters, plugins,
      // credentials, remote builders and daemon selection remain ineligible.
      let context = false;
      for (let i = 0; i < options.length; i++) {
        const flag = options[i];
        if (["--load", "--no-cache", "--pull"].includes(flag)) continue;
        if (
          ["-t", "--tag", "-f", "--file", "--target", "--platform"].includes(
            flag,
          )
        ) {
          const value = options[++i];
          if (
            !value ||
            !/^[a-zA-Z0-9_.:/-]+$/.test(value) ||
            value.startsWith("-") ||
            value.includes("..")
          )
            return decision("deny", "unsafe-build-option");
          continue;
        }
        if (flag === "." && !context) {
          context = true;
          continue;
        }
        return decision("deny", "unsafe-build-option");
      }
      return decision(
        context ? "allow" : "deny",
        context ? "unpublished-build" : "missing-local-context",
      );
    }
    if (/^image (?:ls|inspect)(?: [a-zA-Z0-9_.:/-]+)*$/.test(args.join(" ")))
      return decision("review", "container-diagnostic");
    return decision("deny", "container-mutation");
  }
  if (
    /^git (?:status(?: --short)?|diff(?: --stat| --check| --cached)?|log(?: -[1-9][0-9]?)?|branch --show-current|rev-parse --show-toplevel)$/.test(
      line,
    )
  )
    return decision("allow", "local-inspection");
  if (
    /^git (?:commit|push|reset|clean|checkout|switch|restore|rebase|merge|fetch|pull)\b/.test(
      line,
    )
  )
    return decision("human", "git-mutation");
  if (
    /^npm (?:run (?:lint|typecheck|test)|test)$/.test(line) ||
    /^uv run (?:--active )?(?:--frozen )?(?:pytest|mypy|ruff check|pre-commit run --all-files)$/.test(
      line,
    )
  )
    return decision("allow", "local-validation");
  if (
    /^wood (?:repo (?:info|standards|validate|verify)|contract|doctor)(?: --json)?$/.test(
      line,
    )
  )
    return decision("allow", "wood-local-check");
  if (
    /^wood (?:story|epic|release|project|ci|delivery|deploy|secret)\b/.test(
      line,
    )
  )
    return decision("human", "wood-operation");
  if (/^gh (?:pr view|run view|repo view)(?: [a-zA-Z0-9_.:/-]+)*$/.test(line))
    return decision("review", "github-diagnostic");
  if (/^(?:rm|mv|cp|chmod|chown|truncate|touch)\b/.test(line))
    return decision("human", "filesystem-mutation");
  return decision("deny", "unclassified-executable");
}

export function toolPolicy(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  agentDir: string,
): PolicyDecision {
  if (tool === "bash") return shellPolicy(input.command);
  if (["read", "edit", "write", "find", "grep", "ls"].includes(tool))
    return filePolicy(input.path ?? ".", cwd, agentDir);
  if (
    /google_drive.*(?:create|update|delete|copy|move|share|permission|comment|batch)/i.test(
      tool,
    )
  )
    return decision("human", "drive-write");
  if (/google_drive.*(?:list|search|get|fetch|export)/i.test(tool))
    return decision("human", "drive-read");
  // Child execution and arbitrary custom/codemode/MCP tools need separate,
  // verified policy propagation. They never gain implicit model authority.
  return decision("deny", "unclassified-tool");
}
