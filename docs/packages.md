# Pinned package review

Pi's current upstream is [earendil-works/pi](https://github.com/earendil-works/pi). Use its `@earendil-works` namespace and exact installed declarations; do not add aliases to the superseded namespace. Dependencies and transitive resolutions are pinned by `package-lock.json`, including registry integrity hashes. Install with lifecycle scripts disabled. No `pi install` command downloads moving package versions at startup.

| Package                         | Pin    | Source                   | Role                                                           |
| ------------------------------- | ------ | ------------------------ | -------------------------------------------------------------- |
| @earendil-works/pi-coding-agent | 1.1.0  | earendil-works/pi        | CLI and supported native extension/skill/resource APIs         |
| @earendil-works/pi-tui          | 1.1.0  | earendil-works/pi        | Unicode-aware bounded footer rendering                         |
| @narumitw/pi-plan-mode          | 0.59.2 | narumiruna/pi-extensions | Read-only planning and native plan-mode status                 |
| @narumitw/pi-lsp                | 0.49.9 | narumiruna/pi-extensions | Targeted LSP diagnostics/fixes, servers only on explicit calls |
| pi-subagents                    | 0.76.1 | nicobailon/pi-subagents  | Selective delegation, compact description, scheduling disabled |
| @gotgenes/pi-permission-system  | 40.1.2 | gotgenes/pi-packages     | Interactive permission asks and configured path restrictions   |

These packages declare MIT licenses and compatible peer ranges for the pinned Pi core. Review covered package metadata, declared Pi entrypoints, relevant settings, loader registration, permission default/failure behavior and review-authority seams. This is a focused integration review, not a claim that every dependency's source is secure. Extensions execute in Pi's process with the user's operating-system privileges and can inspect credentials and prompts. Pinning is reproducibility, not sandboxing.

Only explicit extension entrypoints load; bundled community prompts and skills are not installed over the shared Wood skills. Native Pi provides model/context, Git branch and extension status APIs, so the Wood footer reuses them. No separate quota monitor, MCP adapter, OpenProject API client, scheduler or remote execution service is introduced.

The Wood authorization extension precedes all package entrypoints. It registers `wood-independent-review` through the permission system's public session-scoped service and authorizer interface. This replaces the typo-only model judge. Only eligible diagnostic asks reach a distinct configured model; its tool-free request is bounded and malformed replies defer. Human-only actions remain outside its authority. The upstream package's raw review/debug logs stay disabled; Wood writes input-free decision categories and validated reviewer usage to a private audit file. #538 owns Story usage attribution. No model request occurs during resource loading or footer rendering.

The clean-install smoke test uses Pi's real resource loader to register planning, LSP, subagent, permission and footer capabilities without calling a provider or spawning children. It proves package loading/registration, shared-policy loading and selective shared-skill discovery. It does not attest to authenticated model execution, production sandboxing, cross-package child permission propagation, or the later full-workflow integration test.

Upgrades require reviewed exact pins, a refreshed lockfile, clean-install smoke tests and full `wood repo validate`. Missing resources and pin mismatches are errors, never legacy fallbacks. Keep full diagnostic logs local and report bounded results.
