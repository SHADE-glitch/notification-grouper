# AGENTS.md

Guidance for agents working inside `notification-grouper@local` — an original
GNOME Shell 50 extension by SHADE-glitch, with no upstream project to
attribute, published under GPL-2.0-or-later.

## Critical Rules
- **`shell-version` is `["50"]` on purpose.** The extension patches two methods on the
  FDO notification daemon instance (`NotifyAsync`, `_getSourceForPidAndName`) whose
  structure and synchronicity were verified against GNOME 50.1 source. Do not widen the
  range without re-reading `js/ui/notificationDaemon.js` for the target version.
- **The self-degradation guard is load-bearing, per category.** `checkAttachPoints()` in
  `groupEngine.js` returns `attach: false` if either daemon patch point is missing, and the
  grouping then stays completely inert. Never patch one point and leave the other —
  a half-mounted patch loses notifications. The UI guards (see below) degrade
  **separately**: a missing `messageList.js` must cost only the guards, never grouping.
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
- **Do not reassign ESModule export bindings.** Patching a *prototype method* of an
  exported class is allowed, but only for the two whitelisted workarounds below, and the
  original must be captured and restored in `disable()`.
- **The two UI guards are a workaround for a GNOME defect, not a feature** — delete them
  wholesale once upstream fixes it. They patch `Message.prototype.unexpand` and
  `NotificationMessageGroup.prototype.collapse` in `ui/messageList.js`, reached by
  **dynamic `import()`** inside `_attachUiGuards()`. It must stay a dynamic import: a
  static top-level import would put the whole extension into ERROR state if GNOME ever
  renames that module, which is strictly worse than shipping without the guards.
  The defect being worked around, verified against 50.1 line numbers:
  `_removeNotification` reads `item.layout_manager` at :1161 but only deletes the map entry
  inside the animation's `onComplete` at :1170 — so a throw at :1161 leaves a stale message
  in `_notificationToMessage`; `collapse()` then iterates it at :992, `Message.unexpand`
  :646 calls `ease_property('@layout.expansion')`, and because `_easeAnimatableProperty` is
  a **plain (non-async) function** (environment.js:196) the `TypeError` is thrown
  synchronously and `.catch()` at :341 never sees it — so it aborts `collapse()` before
  `_expanded = false` (:998) and `_cover.show()` (:1000). The group is left permanently
  half-collapsed, after which every click is swallowed by the `if (!this.expanded)` branch
  at :1114 and the tray looks dead. That is the user-visible "nothing responds when I click".
- **`_attachUiGuards()` must bail if `disable()` happened while it awaited** — it checks
  `this._enabled` after the `await`. Without that, a fast enable/disable cycle leaves
  patched prototypes that nothing will ever restore.
- **Do not make the guard fall back for actors that are fine.** It diverts only when
  `_bodyBin.layout_manager` is null (i.e. the actor is disposed); `St.Bin` always has one
  otherwise, and `unexpanded` has no listeners in `messageList.js`/`calendar.js`/
  `dateMenu.js`, so skipping that `emit` is safe.
- **Logging discipline**: one line each for enable/attach/disable, never per-notify,
  never log notification bodies. Keep it that way.
- **`disable` must** restore both daemon patches *and* both UI guards (`_detachUiGuards()`),
  disconnect per-source signals, and clear the `_shared` cache.

## Tests
- **`npm test` only covers `groupEngine.js`.** It cannot execute `extension.js` at all — the
  wrappers, the enable/disable contract and the `_shared` cache need a real shell. Use
  **`npm run verify:headless`** (`tests/headless-verify.sh`): it boots a throwaway headless
  GNOME Shell on a private bus and asserts 12 runtime invariants. It is isolated by design
  (`dbus-run-session` + `GSETTINGS_BACKEND=memory` + private `XDG_DATA_HOME`) and must stay
  that way — never point it at the live session or drop the memory backend.
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
- **Verification tiers** (the names `L0`/`L1`/`L2` used by `CHANGELOG.md`, defined by what the
  claim needs, not by the tool): **L0** = `npm test`, no shell required; **L1** =
  `npm run verify:headless` / `npm run verify:ui-guard`, a throwaway shell on a private bus;
  **L2** = the real user session, which nothing here can automate.
- When fixing a bug, add a regression test that **fails against the pre-fix code** first.

## Docs & Commits
- `README.md` and `README.zh-CN.md` are one document in two languages; keep both
  in sync with code changes.
- Commit code first, docs in a separate commit. Commit messages use **Chinese subjects
  with English conventional-commit prefixes** (`fix:` / `perf:` / `test:` / `docs:` / `chore:`).
- Live logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i notification-grouper`

## Recording conventions
- Behaviour changes land in `CHANGELOG.md` as `D-###` entries. Ids are monotonic and
  **never reused**, so a gap in the numbering means an entry was deleted — `check:log` treats it
  as a failure rather than a cleanup.
- `kind` ∈ `fix` | `perf` | `taste` | `guard` | `revert`, cut by **who may demand a revert**: dropping it
  makes a bug → `fix`; dropping it only re-introduces measurable degradation → `perf`; dropping it
  only annoys me → `taste` (it carries zero obligation, and on an
  upgrade it may be discarded wholesale). A change that is both splits into two entries.
  A withdrawal is recorded too — a log without reverts reads like a victory list.
- An entry is an assertion **as of its commit**, not current state. Do not re-verify old entries,
  and do not hand-copy an aggregate count into the file: `npm run check:log` prints them.
- Known-but-not-fixed issues do **not** go in `CHANGELOG.md` — they have no commit, because
  nothing was touched. They live in README § What it does not do and § Known limitations.
- `Symptom` names the mechanism, never the session: no desktop app names, no notification
  bodies, no private toolchain paths (same rule as fixture provenance above).
- Run `npm run check:log` before committing docs. It fails on any commit inside the declared
  coverage window that touched `extension.js` or `groupEngine.js` without being cited by an
  entry. Deliberate scope-outs belong outside the window, never inside an ad-hoc skip list.
