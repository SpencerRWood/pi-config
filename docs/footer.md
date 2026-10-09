# Footer observations

The native `ctx.ui.setFooter` component renders exactly two lines. Row one contains `repo`, `git`, `op`, `mode`, `model` and `ctx`; row two contains `5h`, `week`, `local`, `ci`, `release` and `deploy`. Story identity is a display-only extraction from `feature/op-<id>-...`, not a lifecycle claim. Other branches show `unbound`. Native plan-mode status distinguishes planning from the Pi execution mode. Context comes from Pi's supported `getContextUsage()` API; an unknown estimate remains unavailable.

Values shrink to fit the terminal while retaining field labels where possible. Below the minimum label width, the line is clipped. Wide terminals show complete states. Terminal control and bidirectional override characters are stripped from displayed external values. A 30-second TUI redraw reevaluates expiry without reading files, executing commands or querying services.

The footer reads a bounded, regular, non-symlink `.pi/wood-footer.json` in the target repository at session start, agent end or `/wood-footer-refresh`. Git identity is refreshed at those boundaries and native branch-change events. It has no file watcher, model calls, provider credential inspection or network polling. External edits require an explicit refresh before the cached workspace identity is current. The file is an observation input, not an authorization or completion record. Later Stories provide authoritative producers.

The input schema is version 1:

```json
{
  "schemaVersion": 1,
  "repository": "pi-config",
  "local": {
    "state": "passed",
    "source": "Wood validation record path",
    "revision": "exact verified Git revision",
    "observedAt": "2026-10-09T12:00:00Z",
    "expiresAt": "2026-10-09T12:05:00Z"
  }
}
```

Optional `local`, `ci`, `release` and `deployment` observations use states `passed`, `failed`, `pending`, `blocked` or `unavailable`. Each carries an explicit source, revision and observation/expiry timestamps. Expiry must follow observation by at most 24 hours. Unsupported or malformed inputs fail to unavailable. Expired, future-dated or revision-mismatched observations show `stale`; a dirty or unborn workspace cannot show a passing check. This conservative rule does not attest to validation of uncommitted changes.

Optional `fiveHour` and `weekly` observations add a supported provider identifier and `remainingPercent` between 0 and 100. Producers must use a supported provider authority, not inferred token usage, OAuth credential internals or invented limits. Provider mismatches, unsupported quota data and missing percentages remain unavailable. No quota producer is installed in #533; the display contract is ready for #538 without implementing attribution.

Release readiness and deployment verification are separate fields. A successful CI or release job never makes either gate pass implicitly. Do not write a passed observation without its actual authority. No shipped setting grants deployment permission.
