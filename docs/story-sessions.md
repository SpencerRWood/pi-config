# Story sessions

Pi and Codex use the same Wood Tools claim protocol. The launcher owns no Git or OpenProject client. It runs one contract check, reads a selected Story, verifies goal/criteria presence, previews and applies `wood story start`, then launches the pinned Pi CLI in Wood's returned worktree. Ordinary launch without `--story` remains available.

From the target repository, with a reviewed installation:

```sh
node --import '/absolute/path/to/pi-config/node_modules/tsx/dist/loader.mjs' '/absolute/path/to/pi-config/scripts/pi.ts' --agent-dir '/absolute/path/to/pi-agent' --story next --owner pi-session-unique --worktree '/absolute/path/to/worktrees/target-story'
```

Choose a unique, stable owner ID; keep it for recovery. Reuse the exact owner and path with `--story <id>` after a restart. `--initiative <id>` is a supported selection/activation override; otherwise project and Initiative come from the target Git root's `pyproject.toml`. Read the target repository's guidance and the shared workflow skill. Dependencies and the live open R# planning version are rechecked by Wood on each activation. Dirty primary checkouts stay untouched; a new worktree starts at local `main`, so update that base deliberately before starting. An occupied target or Story branch checked out elsewhere fails instead of moving another checkout. A dirty existing target is resumable only under its active matching claim.

Wood serializes mutations with a nonblocking OS lock in the Git common directory. The claim binds Story, server, repository, branch, worktree and owner. Competing owners are rejected. Owner IDs identify cooperating sessions; they are not authentication secrets or an operating-system security boundary. Claims have no expiry and survive process exits. The same owner must not run concurrently in Pi and Codex. Independent clones and other hosts are outside this host-local protocol; do not assume it gives distributed exclusion.

Inspect local recovery without network access or credentials:

```sh
wood story session get <id> --json
wood story session checkpoint <id> --owner <owner> --phase review --next-action 'Review before commit/push/PR creation' --record <validation-file> --json
wood story session checkpoint <id> --owner <owner> --phase review --next-action 'Review before commit/push/PR creation' --record <validation-file> --apply --json
wood story session handoff <id> --json
wood story session handoff <id> --apply --json
```

Checkpoint phases are implementation, review, delivery, blocked and complete. Repeat `--record` for saved Wood validation, verification, evidence, update or delivery files (at most 20). Paths are references; neither a checkpoint phase nor file presence certifies a passed check. Session observations include revision, dirty state, bounded changed paths and missing-record indicators. Delivery remains unavailable until read from its separate Wood authority. Handoff writes a private JSON artifact outside tracked source in Git metadata and returns its path. The receiver reads that artifact, verifies the binding and resumes with the same owner only after the previous execution has stopped.

Activation persists the claim before Git or remote status mutations. If either fails, inspect the retained claim and retry the same start after resolving the reported failure. Wood does not silently roll back a remote transition or abandon implementation changes. Malformed claims and changed branch/worktree bindings fail clearly.

Keep the standard approval boundary before committing, pushing or creating a PR. Add `--owner <owner>` to Wood status, block, complete and activity writes while the claim is active. Closure continues to require Wood's validation/CI evidence and verified OpenProject activity; a session checkpoint never substitutes for completion evidence. Keep the worktree through delivery. After execution stops and evidence/handoff is retained, preview and apply `wood story session release <id> --owner <owner> --json` with `--apply` on the second call. Release retains the worktree and record references; it does not close the Story or delete branches.

No scheduled runs, automatic permission policy, Drive integration, milestone telemetry, cost attribution, publication or deployment is implemented by this Story.
