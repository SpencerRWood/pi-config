# Pi repository guidance

Read the canonical shared engineering policy from the explicit codex-config path configured by `scripts/install.ts`. Do not copy or override it here. Shared skills remain owned by codex-config and load on demand.

- This repository owns Pi settings, extension selection, footer, permissions configuration and session configuration. Codex remains compatible and its installed homes are not modified.
- Use Wood Tools for OpenProject lifecycle, repository validation and delivery evidence. Repository context is declared in pyproject.toml.
- Work locally. Do not publish images or deploy infrastructure for an individual Story. Release publication requires explicit Release integration approval; the release workflow is manual and has no deployment jobs.
- The current #535 rollout is MacBook-only. Changes to infrastructure or shared CI repositories and their runtime rollout are deferred by explicit user instruction and the revised OpenProject packet. Independent CI/infrastructure enforcement belongs to separately scoped future work.
- #533 establishes configuration and footer; #534 adds Wood-owned lifecycle, worktrees and shared claims; #535 adds local-first authorization, independent review and sanitized auditing. Do not implement #536 Drive integration, #537 milestone/delivery reporting, #538 story attribution or #539 pilot integration in this Story.
- Story launches require Wood's session capability contract, an explicit owner ID and an isolated worktree. Keep claims across process exits; use the same owner to resume, checkpoint saved record paths before handoff, and release explicitly after execution stops. Claims coordinate worktrees of one local repository, not separate clones or hosts.
- Prefer bounded deterministic outputs. No model calls or network polling belong in footer rendering. Missing or stale observations must never look passed.
- Review executable extension sources before activation. Extensions run with the host user's permissions; extension hooks do not establish an operating-system security boundary.
- Use `wood repo validate --json` for the full repository checks. Preserve its saved record and logs. Stop before commit, push or PR creation for review.
