import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import footer from "../extensions/footer.ts";

test("native footer installs only in TUI and cleans up its render resources", () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => void;
  const handlers = new Map<string, Handler>();
  const commands: string[] = [];
  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
  } as unknown as ExtensionAPI;
  footer(api);
  let installs = 0,
    renders = 0,
    disposed = 0;
  let component:
    | { render(width: number): string[]; dispose(): void }
    | undefined;
  let branchChanged: (() => void) | undefined;
  const ctx = {
    mode: "print",
    cwd: process.cwd(),
    model: { id: "test-model", provider: "test-provider" },
    getContextUsage: () => ({ percent: null }),
    ui: {
      setFooter: (
        factory: (
          tui: unknown,
          theme: unknown,
          data: unknown,
        ) => typeof component,
      ) => {
        installs++;
        component = factory(
          {
            requestRender: () => {
              renders++;
            },
          },
          {},
          {
            getGitBranch: () => "feature/op-533-footer",
            getExtensionStatuses: () => new Map([["plan-mode", "plan active"]]),
            onBranchChange: (callback: () => void) => {
              branchChanged = callback;
              return () => {
                disposed++;
              };
            },
          },
        );
      },
    },
  } as unknown as ExtensionContext;
  handlers.get("session_start")!({}, ctx);
  assert.equal(installs, 0);
  Object.assign(ctx, { mode: "tui" });
  handlers.get("session_start")!({}, ctx);
  try {
    assert.equal(installs, 1);
    assert.deepEqual(commands, ["wood-footer-refresh"]);
    const lines = component!.render(240);
    assert.match(lines[0], /mode:plan/);
    assert.match(lines[0], /op:533/);
    assert.match(lines[0], /ctx:unavailable/);
    assert.match(lines[1], /release:unavailable/);
    handlers.get("tool_execution_start")!({}, ctx);
    assert.ok(renders > 0);
    branchChanged!();
  } finally {
    component?.dispose();
  }
  assert.equal(disposed, 1);
});
