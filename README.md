# Wood Pi configuration

The private [pi-config repository](https://github.com/SpencerRWood/pi-config) owns the Wood Pi environment alongside `codex-config`. Shared engineering guidance and skills stay authoritative in `codex-config`; the installer references their real paths. It never changes a Codex home.

Use Node 24 or later and Python 3.14 with `uv` for repository tooling. Node 24 is the centralized CI baseline. From this checkout:

```sh
npm ci --ignore-scripts
uv sync --frozen --group dev
node --import tsx scripts/install.ts --codex-config '/absolute/path/to/codex-config' --agent-dir '/absolute/path/to/new-pi-agent'
npm run smoke -- --agent-dir '/absolute/path/to/new-pi-agent'
```

Installation requires an explicit approved shared source and an empty agent directory. Existing configuration is never overwritten. Paths and pinned dependencies are checked before installation and before launching. For an upgrade, install into a new directory, inspect it, and migrate runtime sessions separately. Authentication files, session transcripts and permission logs belong to that private runtime directory, outside the Git checkout; do not commit them. Use Pi's supported login flow for model authentication. Wood Tools obtains OpenProject credentials from Infisical in the command process; never copy tokens into Pi settings or repository files.

Launch from the **target development repository** so Pi sees its instructions and Wood context:

```sh
node --import '/absolute/path/to/pi-config/node_modules/tsx/dist/loader.mjs' '/absolute/path/to/pi-config/scripts/pi.ts' --agent-dir '/absolute/path/to/new-pi-agent'
```

The launcher executes the exact local pinned Pi CLI with `PI_CODING_AGENT_DIR` set to the explicit installation. Pass Pi options after `--`. A plain launch uses the target working directory. To select and activate a Story through Wood, add `--story next --owner <unique-session-id> --worktree '/absolute/path/to/story-worktree'` before the separator; `--story <id>` resumes or selects an explicit Story. An optional numeric `--initiative` overrides the repository Initiative for selection and activation. Story launch reads the goal/criteria, previews activation, applies it through Wood, and launches Pi in the returned isolated worktree with the binding in its system prompt. It requires Wood's `story session` capability contract; an older installation fails clearly. See [Story sessions](docs/story-sessions.md) for claims, recovery and the commit review boundary.

`/plan` invokes the reviewed planning extension. `/lsp` reports configured server availability; language servers are never downloaded on demand. Subagents are available only for explicitly authorized delegation, with compact tool descriptions, bounded spawn counts and scheduling disabled. Shared skills load on demand through native Pi discovery.

The permission package uses manual interactive asks, allows ordinary file tools within the working directory, and denies configured secret paths. The installed model-judge extension has an empty authorizer chain and therefore no automatic authority or model calls. It only supports deny/defer typo-path review; it is not the general independent approval reviewer required by #535. Do not treat this bootstrap as a tested sandbox or the completed release-policy implementation. See [package review](docs/packages.md).

The [footer contract](docs/footer.md) provides two compact lines for repository/branch/Story/mode/model/context and quota/local checks/CI/Release/deployment observations. The footer does not call providers, poll CI, run tests or modify OpenProject. Missing telemetry is `unavailable`; expired or mismatched evidence is `stale`.

Run full validation with:

```sh
wood repo validate --json
```

The Wood contract runs template-derived pre-commit safety hooks, Prettier, TypeScript and Node tests, including a clean-install smoke test with the real Pi loader. Python exists only for the shared workflow's tooling and semantic-release configuration; Ruff, mypy and pytest are not application checks for this TypeScript repository. CI reuses `SpencerRWood/workflows/.github/workflows/validate.yml@v1`. Release also uses the shared `@v1` contract, but is manual and requires explicit Release integration authorization. No image publication, deployment or infrastructure workflow is present.

#533 implements the foundation and footer; #534 adds lifecycle, worktrees and claims through Wood Tools. #535 owns automatic approval and hardened local-first policy; #536 owns Drive integration; #537 owns deterministic milestone/delivery reporting; #538 owns usage and cost attribution; #539 owns the full pilot. This checkout contains no competing OpenProject client or shared-skill implementation.
