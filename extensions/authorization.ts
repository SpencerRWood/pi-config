import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getPermissionsService,
  PERMISSIONS_READY_CHANNEL,
  PERMISSIONS_DECISION_CHANNEL,
  type Authorizer,
  type PermissionsReadyEvent,
  type PermissionDecisionEvent,
} from "@gotgenes/pi-permission-system";
import { toolPolicy, shellPolicy } from "../lib/authorization.ts";
import { audit } from "../lib/authorization-audit.ts";
import { reviewCommand } from "../lib/approval-reviewer.ts";

export default function authorization(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let registered: ReturnType<typeof getPermissionsService>;
  let dispose: (() => void) | undefined;
  let auditFailed = false;
  const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? "";
  const record = (entry: Parameters<typeof audit>[1]) => {
    try {
      audit(agentDir(), entry);
      return true;
    } catch {
      auditFailed = true;
      return false;
    }
  };
  const authorize: Authorizer["authorize"] = async (details) => {
    const surface = details.accessIntent?.surface ?? details.surface;
    // A forwarded command cannot inherit the parent's cwd or authority.
    if (
      !context ||
      auditFailed ||
      details.forwarding ||
      surface !== "bash" ||
      details.toolName !== "bash" ||
      !details.command ||
      details.command !== details.payload.request.value
    )
      return { kind: "defer" };
    const policy = shellPolicy(details.command);
    if (policy.kind === "deny") return { kind: "deny", reason: policy.reason };
    if (policy.kind === "allow") return { kind: "allow" };
    if (policy.kind !== "review") return { kind: "defer" };
    const reviewed = await reviewCommand(details.command, context);
    if (!record(reviewed.audit))
      return {
        kind: "deny",
        reason: "Private authorization audit is unavailable",
      };
    return reviewed.verdict;
  };
  pi.events.on(PERMISSIONS_READY_CHANNEL, (event: unknown) => {
    const ready = event as PermissionsReadyEvent;
    if (!ready.sessionId || !context) return;
    const service = getPermissionsService(ready.sessionId);
    if (!service || registered === service) return;
    // Register only on this node, never on a child announced on the shared bus.
    if (ready.sessionId !== context.sessionManager.getSessionId()) return;
    dispose?.();
    dispose = service.registerAuthorizer("wood-independent-review", authorize);
    registered = service;
  });
  pi.events.on(PERMISSIONS_DECISION_CHANNEL, (event: unknown) => {
    const resolved = event as PermissionDecisionEvent;
    record({
      phase: "permission",
      result: resolved.result === "allow" ? "allow" : "deny",
      reason: "permission-resolution",
    });
  });
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    auditFailed = false;
  });
  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
    registered = undefined;
    context = undefined;
  });
  // This extension loads before the permission package. Its hard denials apply
  // before cached approval, project overrides, YOLO or any reviewer is consulted.
  pi.on("tool_call", async (event, ctx) => {
    context = ctx;
    const policy = toolPolicy(
      event.toolName,
      event.input as Record<string, unknown>,
      ctx.cwd,
      agentDir(),
    );
    if (
      auditFailed ||
      !record({ phase: "policy", result: policy.kind, reason: policy.reason })
    )
      return {
        block: true,
        reason: "Private authorization audit is unavailable",
      };
    if (policy.kind === "deny")
      return {
        block: true,
        reason: `Wood local-first policy: ${policy.reason}`,
      };
    if (policy.kind === "human") {
      // Once per operation; never turn sensitive approval into a session grant.
      const value =
        event.toolName === "bash"
          ? String(event.input.command).replace(
              /((?:token|password|secret|api[_-]?key)=)[^\s]+/gi,
              "$1[redacted]",
            )
          : String(
              (event.input as Record<string, unknown>).path ??
                "External service operation; inspect the tool request before approval",
            );
      let approved = false;
      try {
        approved =
          ctx.hasUI &&
          (await ctx.ui.confirm(
            "Wood authorization",
            `${event.toolName}: ${value}\nRequires explicit human authorization (${policy.reason}). Approve only this tool call?`,
          ));
      } catch {
        /* unavailable UI denies */
      }
      if (
        !record({
          phase: "policy",
          result: approved ? "allow" : "deny",
          reason: "human-authorization",
        })
      )
        return {
          block: true,
          reason: "Private authorization audit is unavailable",
        };
      if (!approved)
        return { block: true, reason: "Explicit human authorization required" };
    }
    return undefined;
  });
}
