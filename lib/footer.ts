import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type State = "passed" | "failed" | "pending" | "blocked" | "unavailable";
export interface Observation {
  state: State;
  observedAt: string;
  expiresAt: string;
  source: string;
  revision: string;
}
export interface Quota extends Observation {
  provider: string;
  remainingPercent?: number;
}
export interface Snapshot {
  schemaVersion: 1;
  repository: string;
  local?: Observation;
  ci?: Observation;
  release?: Observation;
  deployment?: Observation;
  fiveHour?: Quota;
  weekly?: Quota;
}
export interface Identity {
  repository: string;
  branch: string;
  revision: string;
  dirty: boolean;
  model: string;
  provider: string;
  mode: string;
  contextPercent: number | null;
}

const states: State[] = [
  "passed",
  "failed",
  "pending",
  "blocked",
  "unavailable",
];
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export function parseSnapshot(value: unknown): Snapshot | undefined {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.repository !== "string"
  )
    return;
  const result: Snapshot = { schemaVersion: 1, repository: value.repository };
  for (const key of [
    "local",
    "ci",
    "release",
    "deployment",
    "fiveHour",
    "weekly",
  ] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (
      !object(v) ||
      !states.includes(v.state as State) ||
      ![v.observedAt, v.expiresAt, v.source, v.revision].every(
        (s) => typeof s === "string" && s.length > 0,
      )
    )
      return;
    const start = Date.parse(v.observedAt as string),
      end = Date.parse(v.expiresAt as string);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end - start > 24 * 60 * 60 * 1000
    )
      return;
    if (key === "fiveHour" || key === "weekly") {
      if (
        typeof v.provider !== "string" ||
        !v.provider ||
        (v.remainingPercent !== undefined &&
          (typeof v.remainingPercent !== "number" ||
            !Number.isFinite(v.remainingPercent) ||
            v.remainingPercent < 0 ||
            v.remainingPercent > 100))
      )
        return;
    }
    result[key] = v as unknown as Observation & Quota;
  }
  return result;
}

export function observationState(
  v: Observation | undefined,
  identity: Identity,
  now: number,
): State | "stale" {
  if (!v || v.state === "unavailable") return "unavailable";
  if (
    identity.dirty ||
    !identity.revision ||
    v.revision !== identity.revision ||
    Date.parse(v.observedAt) > now ||
    Date.parse(v.expiresAt) <= now
  )
    return "stale";
  return v.state;
}

export function clean(value: string) {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

function row(fields: [string, string][], width: number) {
  const values = fields.map(([key, value]) => [key, clean(value)]);
  const render = () =>
    values.map(([key, value]) => `${key}:${value}`).join(" ");
  while (visibleWidth(render()) > width) {
    const longest = values.reduce(
      (best, v, i) =>
        visibleWidth(v[1]) > visibleWidth(values[best][1]) ? i : best,
      0,
    );
    const size = visibleWidth(values[longest][1]);
    if (size <= 1) break;
    values[longest][1] = clean(
      truncateToWidth(values[longest][1], size - 1, ""),
    );
  }
  return clean(truncateToWidth(render(), Math.max(0, width), ""));
}

export function renderFooter(
  identity: Identity,
  input: Snapshot | undefined,
  width: number,
  now = Date.now(),
): string[] {
  const snapshot =
    input?.repository === identity.repository ? input : undefined;
  const state = (key: "local" | "ci" | "release" | "deployment") =>
    observationState(snapshot?.[key], identity, now);
  const quota = (key: "fiveHour" | "weekly") => {
    const v = snapshot?.[key];
    if (v?.provider !== identity.provider) return "unavailable";
    const s = observationState(v, identity, now);
    return s === "passed" && v?.remainingPercent !== undefined
      ? `${v.remainingPercent}%`
      : s === "passed"
        ? "unavailable"
        : s;
  };
  const story =
    /^feature\/op-(\d+)(?:-|$)/.exec(identity.branch)?.[1] ?? "unbound";
  const context =
    identity.contextPercent === null ||
    !Number.isFinite(identity.contextPercent) ||
    identity.contextPercent < 0 ||
    identity.contextPercent > 100
      ? "unavailable"
      : `${identity.contextPercent.toFixed(1)}%`;
  return [
    row(
      [
        ["repo", identity.repository],
        ["git", identity.branch + (identity.dirty ? "*" : "")],
        ["op", story],
        ["mode", identity.mode],
        ["model", identity.model],
        ["ctx", context],
      ],
      width,
    ),
    row(
      [
        ["5h", quota("fiveHour")],
        ["week", quota("weekly")],
        ["local", state("local")],
        ["ci", state("ci")],
        ["release", state("release")],
        ["deploy", state("deployment")],
      ],
      width,
    ),
  ];
}
