# AGENTS.md

Guidance for agents working inside `notification-grouper@local` — a local
maintenance fork, published under GPL-2.0-or-later.

## Critical Rules
- **`shell-version` is `["50"]` on purpose.** The extension patches two methods on the
  FDO notification daemon instance (`NotifyAsync`, `_getSourceForPidAndName`) whose
  structure and synchronicity were verified against GNOME 50.1 source. Do not widen the
  range without re-reading `js/ui/notificationDaemon.js` for the target version.
- **The self-degradation guard is load-bearing.** `checkAttachPoints()` in
  `groupEngine.js` returns `attach: false` if either patch point is missing, and the
  extension then stays completely inert. Never patch one point and leave the other —
  a half-mounted patch loses notifications.
- **`NotifyAsync` being synchronous is what makes `_pending` safe.** The try/finally
  stash in `extension.js` relies on JS single-threaded execution plus synchronous D-Bus
  dispatch, with no `await` between the entry point and the Source lookup. If upstream
  ever makes that path async, the stash must become per-invocation state.
- **The stash is validated on two fields, and both are required.** `pid` alone cannot
  detect the dangerous interleaving — the same sender process emitting two notifications
  with different `app_name` has an identical pid, and would silently merge into the wrong
  group and rewrite the stack title. `_pending` therefore also records the raw
  `params[0]`, and `_getSourceForPidAndName` falls through to native when it differs.
  Native passes the same `appName` variable from `NotifyAsync` to the source lookup
  without rewriting it, so the comparison is an identity in the normal case and must
  never fire in the field; a `pending-appname-mismatch` line in the journal means the
  synchronicity assumption broke.
- **`_attach()` must stay idempotent.** It calls `_detachPatches()` before capturing
  `_orig`, so `_orig` doubles as the single "am I currently patched?" flag. Without
  this, a second `enable()` without a `disable()` captures the wrapper as the original;
  the following re-enable then produces `wrapper2 -> wrapper1 -> wrapper1`, which
  reproduced as 504 recursive frames of `extension.js:141` and dropped every
  notification in that headless run. Never reintroduce a direct `this._orig = {...}`
  assignment that is not preceded by a detach.
- **`_detachPatches()` is a no-op when nothing is attached**, so `disable()` may be
  called twice and never reports "restored 0 patches" after a real restore.
- **Do not reassign ESModule exports directly.** Patch the daemon *instance*, and
  restore both patches in `disable()`.
- **Logging discipline**: one line each for enable/attach/disable, never per-notify,
  never log notification bodies. Keep it that way.
- **`disable` must** restore both patches, disconnect per-source signals, and clear
  the `_shared` cache.

## Tests
- **Run `npm test`** after editing `groupEngine.js`. It is `node tests/test-groupEngine.mjs`:
  no dependencies, no build step. `package.json` exists only to name that command; the bare
  `node tests/test-groupEngine.mjs` remains the real gate and must keep working without npm.
- **Run `npm run bench`** after touching `computeGroup()`. It processes 100k
  mixed notifications in a single synchronous burst; the grouping runs on the
  notification hot path, so a regression here is user-visible as input lag.
  It prints throughput and is not an assertion, which is why it is not part of
  `npm test`.
- The suite needs `tests/fixtures/`. Keep fixture provenance free of private toolchain
  paths; the pid evidence is what matters.
- `groupEngine.js` must stay free of `gi://` and `resource://` imports so Node can load it.
- When fixing a bug, add a regression test that **fails against the pre-fix code** first.

## Docs & Commits
- `README.md` is the only doc file; keep it in sync with code changes.
- Commit code first, docs in a separate commit. Commit messages use **Chinese subjects
  with English conventional-commit prefixes** (`fix:` / `perf:` / `test:` / `docs:` / `chore:`).
- Live logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i notification-grouper`
