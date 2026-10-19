import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const USAGE_EVENT = "wood:reviewer-usage:v1";
export type Role = "main" | "subagent" | "reviewer";
export type UsageRow = {
  id: string;
  role: Role;
  provider: string;
  model: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  reportedCostUsd: number | null;
  pricing: "pi-model-registry-estimate" | "unavailable";
};
export type UsageSession = {
  schemaVersion: 1;
  session: string;
  story: number | null;
  observedAt: string;
  contextPercent: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contextProvider: string;
  contextModel: string;
  children: "unavailable" | "observed";
  unresolvedChildren: number | null;
  coverage: "observed-events-only";
  rows: UsageRow[];
};
export const numberOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export const identifier = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(v)
    ? v
    : "unavailable";
export const digest = (v: string) =>
  createHash("sha256").update(v).digest("hex");

export function observedUsage(raw: unknown, stopReason: unknown) {
  const usage = object(raw);
  // Pi initializes failed/aborted responses with zero usage even when the
  // provider never reported any. Preserve nonzero partial usage, not placeholders.
  return ["error", "aborted"].includes(String(stopReason)) &&
    ![
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.totalTokens,
    ].some((value) => (numberOrNull(value) ?? 0) > 0)
    ? {}
    : raw;
}

// Zero prices in custom/OAuth model definitions do not establish free usage.
export function usageRow(
  id: string,
  role: Role,
  provider: unknown,
  model: unknown,
  raw: unknown,
  rates?: unknown,
): UsageRow {
  const usage = object(raw),
    cost = object(usage.cost),
    pricing = object(rates);
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const knownPricing =
    fields.every((key) => numberOrNull(pricing[key]) !== null) &&
    fields.some((key) => Number(pricing[key]) > 0);
  const values = fields.map((key) => numberOrNull(usage[key]));
  const totalTokens =
    numberOrNull(usage.totalTokens) ??
    (values.every((v) => v !== null)
      ? values.reduce<number>((a, b) => a + b!, 0)
      : null);
  const reportedCostUsd = numberOrNull(cost.total ?? usage.cost);
  return {
    id: digest(id),
    role,
    provider: identifier(provider),
    model: identifier(model),
    input: values[0],
    output: values[1],
    cacheRead: values[2],
    cacheWrite: values[3],
    totalTokens,
    reportedCostUsd,
    costUsd: knownPricing ? reportedCostUsd : null,
    pricing: knownPricing ? "pi-model-registry-estimate" : "unavailable",
  };
}

export function summarize(rows: UsageRow[]) {
  const sum = (key: "totalTokens" | "costUsd") => {
    const missing = rows.filter((row) => row[key] === null).length;
    const known = rows.reduce((n, row) => n + (row[key] ?? 0), 0);
    return { known, unknownRecords: missing, total: missing ? null : known };
  };
  return {
    records: rows.length,
    tokens: sum("totalTokens"),
    costUsd: sum("costUsd"),
  };
}

export function usageDisplay(value: UsageSession) {
  const total = summarize(value.rows);
  const partial =
    value.children !== "observed" || value.unresolvedChildren !== 0;
  return {
    tokens:
      total.tokens.total === null
        ? `${total.tokens.known}+unknown`
        : `${total.tokens.known}${partial ? "+unknown" : ""}`,
    cost:
      total.costUsd.total === null || partial
        ? `unknown($${total.costUsd.known.toFixed(4)} known)`
        : `~$${total.costUsd.known.toFixed(4)}`,
  };
}

export function storyUsage(sessions: UsageSession[], story: number | null) {
  const selected = sessions
    .filter((session) => session.story === story)
    .sort((a, b) => a.session.localeCompare(b.session));
  const rows = selected.flatMap((session) => session.rows);
  const aggregate = (input: UsageRow[]) =>
    selected.length
      ? summarize(input)
      : {
          records: 0,
          tokens: { known: 0, unknownRecords: 0, total: null },
          costUsd: { known: 0, unknownRecords: 0, total: null },
        };
  return {
    schemaVersion: 1,
    story,
    available: selected.length > 0,
    coverage: "observed-events-only",
    complete: false, // Historical/pre-extension usage and failed requests may be missing.
    sessions: selected.map((session) => ({
      ...session,
      footer: usageDisplay(session),
    })),
    byRole: Object.fromEntries(
      (["main", "subagent", "reviewer"] as const).map((role) => [
        role,
        aggregate(rows.filter((row) => row.role === role)),
      ]),
    ),
    byProvider: Object.fromEntries(
      [...new Set(rows.map((row) => row.provider))]
        .sort()
        .map((provider) => [
          provider,
          aggregate(rows.filter((row) => row.provider === provider)),
        ]),
    ),
    total: aggregate(rows),
    childrenAvailable:
      selected.length > 0 &&
      selected.every(
        (session) =>
          session.children === "observed" && session.unresolvedChildren === 0,
      ),
  };
}

function directory(agentDir: string) {
  if (!isAbsolute(agentDir))
    throw new Error("Explicit private agent directory required");
  const root = realpathSync(agentDir);
  if (relative(process.cwd(), root).split(/[\\/]/)[0] !== "..")
    throw new Error("Usage directory must be outside the working repository");
  const dir = join(root, "wood-usage");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Unsafe usage directory");
  return dir;
}
function read(file: string): UsageSession {
  const fd = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 8 * 1024 * 1024 ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Unsafe usage file");
    const value = JSON.parse(readFileSync(fd, "utf8")) as UsageSession;
    if (
      value.schemaVersion !== 1 ||
      typeof value.session !== "string" ||
      identifier(value.session) !== value.session ||
      (value.story !== null &&
        (!Number.isSafeInteger(value.story) || value.story < 1)) ||
      !Number.isFinite(Date.parse(value.observedAt)) ||
      identifier(value.contextProvider) !== value.contextProvider ||
      identifier(value.contextModel) !== value.contextModel ||
      [value.contextTokens, value.contextWindow].some(
        (v) => v !== null && numberOrNull(v) === null,
      ) ||
      (value.contextPercent !== null &&
        (numberOrNull(value.contextPercent) === null ||
          value.contextPercent > 100)) ||
      !["observed", "unavailable"].includes(value.children) ||
      (value.unresolvedChildren !== null &&
        (!Number.isSafeInteger(value.unresolvedChildren) ||
          value.unresolvedChildren < 0)) ||
      !Array.isArray(value.rows) ||
      value.rows.length > 10000 ||
      new Set(value.rows.map((row) => row?.id)).size !== value.rows.length ||
      value.rows.some(
        (row) =>
          !row ||
          !/^[a-f0-9]{64}$/.test(row.id) ||
          !["main", "subagent", "reviewer"].includes(row.role) ||
          identifier(row.provider) !== row.provider ||
          identifier(row.model) !== row.model ||
          !["pi-model-registry-estimate", "unavailable"].includes(
            row.pricing,
          ) ||
          [
            row.input,
            row.output,
            row.cacheRead,
            row.cacheWrite,
            row.totalTokens,
            row.costUsd,
            row.reportedCostUsd,
          ].some((v) => v !== null && numberOrNull(v) === null) ||
          Object.keys(row).some(
            (key) =>
              ![
                "id",
                "role",
                "provider",
                "model",
                "input",
                "output",
                "cacheRead",
                "cacheWrite",
                "totalTokens",
                "costUsd",
                "reportedCostUsd",
                "pricing",
              ].includes(key),
          ),
      ) ||
      Object.keys(value).some(
        (key) =>
          ![
            "schemaVersion",
            "session",
            "story",
            "observedAt",
            "contextPercent",
            "contextTokens",
            "contextWindow",
            "contextProvider",
            "contextModel",
            "children",
            "unresolvedChildren",
            "coverage",
            "rows",
          ].includes(key),
      ) ||
      value.coverage !== "observed-events-only"
    )
      throw new Error("Invalid usage file");
    return value;
  } finally {
    closeSync(fd);
  }
}
export function readUsage(agentDir: string): UsageSession[] {
  const dir = directory(agentDir);
  const files = readdirSync(dir)
    .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
    .sort();
  if (files.length > 1000)
    throw new Error("Usage report exceeds session bound");
  return files.map((file) => {
    const saved = read(join(dir, file));
    if (file !== `${digest(saved.session)}.json`)
      throw new Error("Usage filename binding mismatch");
    return saved;
  });
}
export function loadUsage(
  agentDir: string,
  session: string,
  story: number | null,
): UsageSession {
  try {
    const saved = read(join(directory(agentDir), `${digest(session)}.json`));
    if (saved.session !== session || saved.story !== story)
      throw new Error("Usage session binding mismatch");
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      session,
      story,
      observedAt: new Date().toISOString(),
      contextPercent: null,
      contextTokens: null,
      contextWindow: null,
      contextProvider: "unavailable",
      contextModel: "unavailable",
      children: "unavailable",
      unresolvedChildren: null,
      coverage: "observed-events-only",
      rows: [],
    };
  }
}
export function saveUsage(agentDir: string, value: UsageSession) {
  if (value.rows.length > 10000)
    throw new Error("Usage session exceeds record bound");
  const dir = directory(agentDir),
    target = join(dir, `${digest(value.session)}.json`),
    temporary = join(dir, `.${randomUUID()}.tmp`);
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > 8 * 1024 * 1024)
    throw new Error("Usage session exceeds byte bound");
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
