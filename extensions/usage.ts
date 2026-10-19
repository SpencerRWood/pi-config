import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  USAGE_EVENT,
  loadUsage,
  saveUsage,
  storyUsage,
  readUsage,
  usageRow,
  observedUsage,
  numberOrNull,
  identifier,
  type UsageSession,
  type UsageRow,
} from "../lib/usage.ts";
import { setLiveUsage } from "../lib/usage-display.ts";

export default function usage(pi: ExtensionAPI) {
  // Detached children load ambient extensions. Their usage is already owned by
  // the parent's cost RPC; recording them again would double-charge the Story.
  // Foreground children do not load ambient extensions in the pinned package.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  let current: UsageSession | undefined;
  let context: ExtensionContext | undefined;
  let baseline = new Set<string>();
  const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? "";
  const persist = () => {
    if (!current || !context) return;
    try {
      current.observedAt = new Date().toISOString();
      const estimate = context.getContextUsage();
      const percent = numberOrNull(estimate?.percent);
      current.contextTokens = numberOrNull(estimate?.tokens);
      current.contextWindow = numberOrNull(estimate?.contextWindow);
      current.contextProvider = identifier(context.model?.provider);
      current.contextModel = identifier(context.model?.id);
      current.contextPercent =
        percent !== null && percent <= 100 ? percent : null;
      saveUsage(agentDir(), current);
      setLiveUsage(current);
      context.ui.setStatus("wood-usage", "usage:observed");
    } catch {
      setLiveUsage(undefined);
      context.ui.setStatus("wood-usage", "usage:unavailable");
    }
  };
  const upsert = (row: UsageRow) => {
    if (!current) return;
    const index = current.rows.findIndex((saved) => saved.id === row.id);
    if (index === -1) current.rows.push(row);
    else current.rows[index] = row;
  };
  const capture = (ctx: ExtensionContext) => {
    if (!current || current.session !== ctx.sessionManager.getSessionId())
      return;
    context = ctx;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (baseline.has(entry.id)) continue;
      baseline.add(entry.id);
      if (entry.type === "message" && entry.message.role === "assistant") {
        const message = entry.message;
        const model = ctx.modelRegistry.find(message.provider, message.model);
        upsert(
          usageRow(
            `main:${entry.id}`,
            "main",
            message.provider,
            message.model,
            observedUsage(message.usage, message.stopReason),
            model?.cost,
          ),
        );
      } else if (entry.type === "usage") {
        upsert(
          usageRow(
            `usage:${entry.id}`,
            "main",
            entry.provider,
            entry.model,
            entry.usage,
            ctx.modelRegistry.find(entry.provider, entry.model)?.cost,
          ),
        );
      } else if (
        (entry.type === "compaction" || entry.type === "branch_summary") &&
        entry.usage
      ) {
        // Compaction entries do not identify the model that actually ran.
        upsert(
          usageRow(
            `${entry.type}:${entry.id}`,
            "main",
            undefined,
            undefined,
            entry.usage,
          ),
        );
      }
    }
    persist();
  };
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    current = undefined;
    setLiveUsage(undefined);
    baseline = new Set(
      ctx.sessionManager.getEntries().map((entry) => entry.id),
    );
    const raw = process.env.WOOD_PI_STORY_ID;
    const story =
      raw && /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw))
        ? Number(raw)
        : null;
    try {
      current = loadUsage(agentDir(), ctx.sessionManager.getSessionId(), story);
      // Only newly observed calls are attributed; never charge imported/forked
      // transcript history to this Story or replay it after extension reload.
      persist();
    } catch {
      ctx.ui.setStatus("wood-usage", "usage:unavailable");
    }
  });
  pi.on("turn_end", (_event, ctx) => capture(ctx));
  pi.on("session_compact", (_event, ctx) => capture(ctx));
  pi.on("session_tree", (_event, ctx) => capture(ctx));
  pi.events.on(USAGE_EVENT, (raw: unknown) => {
    const event = raw as { session?: string; row?: UsageRow };
    if (
      !current ||
      event?.session !== current.session ||
      event.row?.role !== "reviewer"
    )
      return;
    upsert(event.row);
    persist();
  });
  const children = async (ctx: ExtensionContext) => {
    if (!current) return;
    const saved = current;
    saved.children = "unavailable";
    saved.unresolvedChildren = null;
    const requestId = randomUUID();
    // Package-owned read-only accounting; never spawn children or read private
    // transcript paths ourselves. Its parent totals exclude the reviewer, and
    // are deliberately ignored to avoid charging main-agent usage twice.
    const response = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        dispose();
        resolve(undefined);
      }, 1500);
      const dispose = pi.events.on(
        `subagents:rpc:v1:reply:${requestId}`,
        (reply) => {
          clearTimeout(timer);
          dispose();
          resolve(reply);
        },
      );
      pi.events.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId,
        method: "cost",
        params: {},
      });
    });
    if (
      current !== saved ||
      saved.session !== ctx.sessionManager.getSessionId()
    )
      return;
    const reply = response as
      | {
          version?: number;
          success?: boolean;
          data?: {
            version?: number;
            children?: {
              runId?: string;
              sessionFile?: string;
              usage?: unknown;
            }[];
            unresolvedAsyncChildren?: number;
          };
        }
      | undefined;
    const data = reply?.data;
    if (
      reply?.version === 1 &&
      reply.success === true &&
      data?.version === 1 &&
      Array.isArray(data.children) &&
      data.children.length <= 1000 &&
      Number.isSafeInteger(data.unresolvedAsyncChildren) &&
      Number(data.unresolvedAsyncChildren) >= 0
    ) {
      saved.children = "observed";
      saved.unresolvedChildren = Number(data.unresolvedAsyncChildren);
      for (const child of data.children) {
        const key = child.runId ?? child.sessionFile;
        if (typeof key !== "string" || !key || key.length > 4096) {
          saved.children = "unavailable";
          continue;
        }
        // Cumulative child observations replace earlier totals, including across
        // resumed runs. RPC v1 has no provider/model/pricing authority.
        upsert(
          usageRow(
            `child:${key}`,
            "subagent",
            undefined,
            undefined,
            child.usage,
          ),
        );
      }
    }
    persist();
  };
  pi.on("agent_settled", async (_event, ctx) => {
    capture(ctx);
    await children(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    capture(ctx);
    current = undefined;
    context = undefined;
    setLiveUsage(undefined);
  });
  pi.registerCommand("wood-usage-report", {
    description:
      "Show reproducible local Story usage JSON; no provider or model calls",
    handler: async (args, ctx) => {
      capture(ctx);
      const selector = args.trim();
      if (
        selector &&
        (!/^[1-9][0-9]*$/.test(selector) ||
          !Number.isSafeInteger(Number(selector)))
      )
        throw new Error("Supply a positive Story ID");
      const story = selector ? Number(selector) : (current?.story ?? null);
      const report = storyUsage(readUsage(agentDir()), story);
      // A local viewer only; never inject telemetry into model context.
      if (!ctx.hasUI)
        throw new Error(
          "Use scripts/usage-report.ts for noninteractive JSON reports",
        );
      await ctx.ui.editor(
        "Story usage report (local copy)",
        JSON.stringify(report, null, 2),
      );
    },
  });
}
