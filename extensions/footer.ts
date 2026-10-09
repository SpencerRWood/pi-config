import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { renderFooter } from "../lib/footer.ts";
import { readSnapshot, repositoryIdentity } from "../lib/telemetry.ts";

export default function footer(pi: ExtensionAPI) {
  let identity: ReturnType<typeof repositoryIdentity>;
  let snapshot: ReturnType<typeof readSnapshot>;
  let refreshUI: (() => void) | undefined;
  const refresh = (ctx: ExtensionContext) => {
    identity = repositoryIdentity(ctx.cwd);
    snapshot = readSnapshot(identity.root);
    refreshUI?.();
  };
  pi.registerCommand("wood-footer-refresh", {
    description:
      "Refresh local footer observations; no network or validation execution",
    handler: async (_args, ctx) => {
      refresh(ctx);
    },
  });
  pi.on("session_start", (_event, ctx) => {
    refresh(ctx);
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, _theme, data) => {
      refreshUI = () => tui.requestRender();
      const unsubscribe = data.onBranchChange(() => refresh(ctx));
      // Only a TUI render timer, no telemetry polling, model calls or context injection.
      const timer = setInterval(() => tui.requestRender(), 30_000);
      timer.unref();
      return {
        invalidate() {},
        render(width: number) {
          const plan = data.getExtensionStatuses().get("plan-mode");
          return renderFooter(
            {
              ...identity,
              branch: data.getGitBranch() ?? "unavailable",
              model: ctx.model?.id ?? "unavailable",
              provider: ctx.model?.provider ?? "unavailable",
              mode:
                plan?.startsWith("plan active") || plan === "plan ready"
                  ? "plan"
                  : ctx.mode,
              contextPercent: ctx.getContextUsage()?.percent ?? null,
            },
            snapshot,
            width,
          );
        },
        dispose() {
          clearInterval(timer);
          unsubscribe();
          refreshUI = undefined;
        },
      };
    });
  });
  pi.on("agent_end", (_event, ctx) => refresh(ctx));
  pi.on("tool_execution_start", () => {
    // Any executing tool may mutate files; invalidate success before it runs.
    if (identity) identity = { ...identity, dirty: true };
    refreshUI?.();
  });
  pi.on("model_select", () => refreshUI?.());
}
