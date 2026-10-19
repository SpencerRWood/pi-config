import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  milestoneTrigger,
  reportMilestones,
  type ReportingSelection,
} from "../lib/milestones.ts";
import { runWood, type WoodRunner } from "../lib/story.ts";

export default function milestones(
  pi: ExtensionAPI,
  run: WoodRunner = runWood,
) {
  let active: ReportingSelection | undefined;
  let ready = false;
  const report = (cwd: string, options: Partial<ReportingSelection> = {}) => {
    if (!active || !ready)
      throw new Error("Milestone reporting is unavailable");
    return reportMilestones({ ...active, ...options }, cwd, run);
  };
  pi.on("session_start", (_event, ctx) => {
    active = undefined;
    ready = false;
    const story = process.env.WOOD_PI_STORY_ID;
    const owner = process.env.WOOD_PI_STORY_OWNER;
    if (!story || !owner) return;
    active = { story, owner };
    try {
      const contract = run(["contract"], ctx.cwd).data;
      const capability = contract.milestones as
        | { version?: unknown }
        | undefined;
      if (
        capability?.version !== 1 ||
        !Array.isArray(contract.capabilities) ||
        !contract.capabilities.includes("story milestones")
      )
        throw new Error("Unsupported Wood");
      ready = true;
      report(ctx.cwd);
      ctx.ui.setStatus("wood-milestones", "milestones:reported");
    } catch {
      ctx.ui.setStatus(
        "wood-milestones",
        ready ? "milestones:pending" : "milestones:unavailable",
      );
    }
  });
  pi.on("tool_result", (event, ctx) => {
    if (
      !ready ||
      !active ||
      event.isError ||
      event.parentToolCallId ||
      event.toolName !== "bash"
    )
      return;
    const trigger = milestoneTrigger(
      event.input.command,
      event.content.flatMap((item) =>
        item.type === "text" ? [item.text] : [],
      ),
    );
    if (!trigger) return;
    try {
      report(ctx.cwd, trigger);
      ctx.ui.setStatus("wood-milestones", "milestones:reported");
    } catch {
      ctx.ui.setStatus("wood-milestones", "milestones:pending");
    }
  });
  pi.registerCommand("wood-report", {
    description:
      "Report verified Story milestones; optional JSON {validation, pr, readiness} or retry",
    handler: async (args, ctx) => {
      try {
        const options: Partial<ReportingSelection> =
          args.trim() === "retry"
            ? { retry: true }
            : args.trim()
              ? JSON.parse(args)
              : {};
        if (
          !options ||
          typeof options !== "object" ||
          Array.isArray(options) ||
          (Object.keys(options).some(
            (key) =>
              ![
                "validation",
                "pr",
                "readiness",
                "reviewReference",
                "reviewedRevision",
              ].includes(key),
          ) &&
            args.trim() !== "retry")
        )
          throw new Error("Invalid selectors");
        report(ctx.cwd, options);
        ctx.ui.setStatus("wood-milestones", "milestones:reported");
        ctx.ui.notify(
          "Wood milestones reported. Release and deployment remain separately gated.",
          "info",
        );
      } catch {
        ctx.ui.setStatus("wood-milestones", "milestones:pending");
        ctx.ui.notify(
          "Milestones were not confirmed. Inspect Wood's outbox and retry with /wood-report retry; newer Wood Tools may be required.",
          "warning",
        );
      }
    },
  });
}
