import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

export type AuditRecord = {
  phase: "policy" | "reviewer" | "permission";
  result: "allow" | "deny" | "human" | "review" | "defer";
  reason: string;
  reviewerCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
};

// No commands, inputs, paths, prompts, exception messages or model prose.
// Every value comes from code-owned enums or validated numeric usage.
export function audit(agentDir: string, record: AuditRecord) {
  if (!isAbsolute(agentDir))
    throw new Error("Explicit private agent directory required");
  const root = realpathSync(agentDir);
  if (
    relative(root, process.cwd()) === "" ||
    relative(process.cwd(), root).split(/[\\/]/)[0] !== ".."
  )
    throw new Error("Audit directory must be outside the working repository");
  const dir = join(root, "wood-authorization");
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const stat = lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Unsafe audit directory");
  const fd = openSync(
    join(dir, "decisions.jsonl"),
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const file = fstatSync(fd);
    if (
      !file.isFile() ||
      file.nlink !== 1 ||
      (file.mode & 0o077) !== 0 ||
      file.uid !== process.getuid?.()
    )
      throw new Error("Unsafe audit file");
    writeSync(
      fd,
      JSON.stringify({
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        id: randomUUID(),
        ...record,
      }) + "\n",
    );
  } finally {
    closeSync(fd);
  }
}
