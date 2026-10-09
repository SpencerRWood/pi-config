import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  publishPermissionsService,
  unpublishPermissionsService,
  PERMISSIONS_READY_CHANNEL,
  type PermissionsService,
  type Authorizer,
} from "@gotgenes/pi-permission-system";
import authorization from "../extensions/authorization.ts";
import { createSettings } from "../lib/config.ts";

const root = mkdtempSync(join(tmpdir(), "wood-authorization-extension-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("hard gate precedes reviewer/cached permission authority and sensitive approval is per call", async () => {
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const listeners = new Map<string, (event: unknown) => void>();
  const api = {
    on: (name: string, hook: any) => hooks.set(name, hook),
    events: { on: (name: string, hook: any) => listeners.set(name, hook) },
  } as unknown as ExtensionAPI;
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { mode: 0o700 });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let confirms = 0,
    registered = 0,
    disposed = 0;
  let authorizer: Authorizer["authorize"] | undefined;
  const service = {
    registerAuthorizer: (_name: string, callback: Authorizer["authorize"]) => {
      registered++;
      authorizer = callback;
      return () => {
        disposed++;
      };
    },
  } as PermissionsService;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: { getSessionId: () => "policy-test" },
    ui: {
      confirm: async () => {
        confirms++;
        return true;
      },
    },
  } as unknown as ExtensionContext;
  publishPermissionsService("policy-test", service);
  try {
    authorization(api);
    hooks.get("session_start")!({}, ctx);
    listeners.get(PERMISSIONS_READY_CHANNEL)!({ sessionId: "other-session" });
    assert.equal(registered, 0);
    listeners.get(PERMISSIONS_READY_CHANNEL)!({ sessionId: "policy-test" });
    listeners.get(PERMISSIONS_READY_CHANNEL)!({ sessionId: "policy-test" });
    assert.equal(registered, 1);
    assert.ok(authorizer);
    const tool = (command: string) =>
      hooks.get("tool_call")!({ toolName: "bash", input: { command } }, ctx);
    for (const command of [
      "docker push local",
      "gh workflow run deploy.yml",
      "bash -c 'docker push local'",
    ])
      assert.equal((await tool(command)).block, true);
    assert.equal(confirms, 0);
    assert.equal(await tool("npm test"), undefined);
    assert.equal(confirms, 0);
    assert.equal(await tool("git push origin branch"), undefined);
    assert.equal(await tool("git push origin branch"), undefined);
    assert.equal(confirms, 2);
    Object.assign(ctx, { hasUI: false });
    assert.equal((await tool("git push origin branch")).block, true);
    assert.equal(confirms, 2);
    rmSync(join(agentDir, "wood-authorization"), { recursive: true });
    mkdirSync(join(agentDir, "wood-authorization"), { mode: 0o755 });
    assert.equal((await tool("npm test")).block, true);
    assert.equal((await tool("git status")).block, true);
  } finally {
    hooks.get("session_shutdown")!({}, ctx);
    unpublishPermissionsService("policy-test", service);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  assert.equal(disposed, 1);
});

test("reviewed installation places the Wood hard gate ahead of the permission engine", () => {
  const settings = createSettings("/repo", "/shared");
  assert.equal(settings.extensions[0], "/repo/extensions/authorization.ts");
});
