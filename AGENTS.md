# AGENTS.md

Guidance for agents working inside `notification-grouper@local` — an original
GNOME Shell 50 extension by SHADE-glitch, with no upstream project to attribute,
published under GPL-2.0-or-later.

This file is the **rulebook**. Verifiable facts, native line anchors and procedures live in
[`MAINTENANCE.md`](MAINTENANCE.md); per-phase evidence lives in `reports/`, which is
gitignored and must never be pushed. Do not copy MAINTENANCE's tables in here — duplicated
facts are the thing that drifts.

## How we work
- Solo maintainer, AI-paired, vibe-coded. Four phases: **A** audit with `file:line` evidence
  → **B** options (2–3 alternatives, with a recommendation wherever there is a trade-off) →
  **C** implement **one small change at a time** → **D** verify and inscribe.
  **Stop at the end of every phase and wait for confirmation.**
- When the three goals conflict: **stability > resource cost > aesthetics**. In that order.
- Never commit, push, or widen scope on your own. Never refactor for architecture's sake:
  no DI container, no event bus, no extra layer without pain evidence. Behaviour-preserving
  refactors must come with the verification that proves behaviour held.
- Something a well-maintained repo should have but this one lacks? **Ask**, one item at a
  time (what / why / cost / recommendation). Never add it silently.
- Label every claim: **R** ran on this machine, **S** static inference (read, not run),
  **M** needs the user's real session. No "verified" without an R line and the command that
  produced it.
- Local green is not CI green, and neither is L2. Say which tier you ran.
- **L2 means real senders** — a CLI hook, a tool's `--app-name`, a systemd-emitted
  notification. A synthetic notification proves only that the FDO transport works, and that
  was never the bug.
- Constraints that do not expire: do not touch system or GNOME-wide configuration, do not
  delete existing features, do not switch stacks, do not add dependencies, do not pad the
  code with defensive `try/catch` or optional chaining around things that cannot fail.

## Critical rules

### The three patch layers
- **`shell-version` is `["50"]` on purpose.** The extension wraps methods on the FDO
  notification daemon whose names, signatures and synchronicity were read from GNOME 50.1
  source. Widen the range only after re-reading **every** entry in
  `MAINTENANCE.md § Shell 内部接口清单` against the target version — not after a smoke test.
- **Self-degradation is per category, not global.** `checkAttachPoints()` returns
  `attach: false` if either daemon patch point is missing and grouping then stays completely
  inert: never mount one point and leave the other, because a half-mounted patch loses
  notifications. The UI workarounds degrade **separately** — a missing `messageList.js` must
  cost only the workarounds, never grouping.
- **`NotifyAsync` being synchronous is what makes `_pending` safe.** The try/finally stash
  relies on JS single-threaded execution plus synchronous D-Bus dispatch, with no `await`
  between the entry point and the source lookup. If upstream ever makes that path
  asynchronous, the stash has to become per-invocation state.
- **The stash is validated on two fields and both are required.** `pid` alone cannot see the
  dangerous interleaving: one sender process emitting two notifications with different
  `app_name` has the same pid and would merge into the wrong group and rewrite the stack
  title. `_pending` therefore also records the raw `params[0]`, and
  `_getSourceForPidAndName` falls through to native when it differs. Native passes the same
  `appName` variable through without rewriting it, so the comparison is an identity in the
  normal case and must never fire in the field; a `pending-*-mismatch` line in the journal
  means the synchronicity assumption broke.
- **Patching a prototype method of an exported ES-module class is allowed only for the
  three workarounds in `uiWorkarounds.js`**, and the original must be captured and restored.
  The only other patch is the **per-instance** `open()` override, and only on sources this
  extension created. Do not reassign ESModule *export bindings* — never possible, never try.
- **The merged source's `open()` override is load-bearing.** Native
  `FdoNotificationDaemonSource.open()` ends in `destroyNonResidentNotifications()`, which
  empties the whole source. A native source holds roughly one card so that is invisible; a
  merged source holds the whole group, so the click that opens one card wipes every card in
  it. The override keeps `openApp()` (a no-op here — `source.app` is null on this path) and
  drops the mass destroy. Native sources are never touched; restoration happens per record
  and is guarded by `source.open === rec.patchedOpen` so a re-entrant create cannot clobber
  the wrong method. If `source.open` is not a function, grouping still works and one warning
  is logged.
- **The `close` workaround exists for the same amplification reason, not for the collapse
  defect.** Native `messageList.js:1107-1112` reacts to every message's `close` signal: in a
  collapsed group it stops the emission and closes the whole group. Divert it to
  `this.on_close()` (the signal's default handler, auto-wired by GJS — verified) **only**
  when all three hold: the message's group is a `NotificationMessageGroup`, that group is
  collapsed, and `group.source` belongs to this extension. Everything else falls through.
  Do not widen the condition to native sources, expanded groups, or single-card groups — a
  one-card group reports `expanded === true` (`:952`) and must keep the native path.
- **`uiWorkarounds.js` is the deletion unit.** The defect it works around belongs upstream;
  when GNOME fixes it, the file goes away — together with its harness, its declared guard
  list and the branches that call it. Its header carries the exact file checklist; follow it
  instead of improvising, and do not let a single guard creep back into `extension.js`
  (`npm test` has a guard for that leak). Until then, the `ui-guards` setting is the runtime
  equivalent of the same deletion.
- **An async attach must re-check liveness after its await, and must detach after it — not
  before it.** `_mountUiGuards()`/`UiWorkarounds.attach()` await a dynamic `import()`; the
  caller may have been disabled, or flipped the switch off, while that was in flight. The
  detach that precedes *capturing* the originals has to run **after** that await, otherwise
  it detaches nothing and the capture stores the previous wrapper as the "native" method,
  which stacks layers on every re-enable.

### The enable/disable contract
- **Every layer must be detach-before-capture, and `_attach()` must stay idempotent.**
  `_orig` doubles as the single "am I currently patched?" flag. Without this, a second
  `enable()` without a `disable()` captures the wrapper as the original; the following
  re-enable produces `wrapper2 -> wrapper1 -> wrapper1`, which reproduced as 504 recursive
  frames inside one stack and dropped every notification of that run.
- **`enable()` must not reset state it owns.** Rebuilding `_shared` / `_ownSources` at the
  top of `enable()` orphans the `open()` overrides and `destroy` connections already mounted
  on other people's objects: nothing holds them any more, so `disable()` cannot undo them,
  and the `close` workaround silently degrades back to "close one card, close the group".
  Reset bookkeeping fields only. This is the same invariant as the previous bullet, applied
  to the second and third layer — the first one was fixed in v4 and the others were not.
- **`disable()` must be able to undo everything `enable()` did**, for every layer: both
  daemon patches, each self-created source's `open()`, every per-source signal, all three
  prototypes, all four `changed::` settings handlers — **and the merged sources themselves**.
  A self-created source holds a `Gio.DBus.watch_name` subscription and a
  `NotificationPolicy` that only `Source.destroy()` releases; and once `open()` has been
  restored to the native one, leaving that source alive puts "click one card, lose the group"
  back on the table *after* disabling. Native
  `FdoNotificationDaemonSource.destroy()` drops the reason argument, so those cards reach
  the sender as `NotificationClosed` reason 4 (`undefined`) — accepted, documented.
- **`_detachPatches()` is a no-op when nothing is attached**, so `disable()` may be called
  twice and never reports "restored 0 patches" after a real restore.

### Hot path, logging, settings
- **Zero timers, ever.** No `timeout_add`, `idle_add`, `setTimeout`, `TickScheduler`: the
  cost model is "this extension only runs when a notification arrives", and one repeating
  source would falsify it while every runtime assertion stayed green. `npm test` greps for
  this.
- **No IO and no regex on the notification hot path.** Settings are read once at enable and
  refreshed by `changed::` into an in-memory cache; the exception list is a `Set` of already
  normalised names, built in `_readSettings()`, never compared by scanning the raw list.
- **No Gtk/Gdk/Adw in shell-process files** (`extension.js`, `uiWorkarounds.js`,
  `groupEngine.js`) — that is a load-time crash, not a style issue. `prefs.js` runs in its
  own GTK4 process and *must* import Adw; both directions are asserted.
- **Schema keys are public API.** Once released, a key name never changes and its type never
  changes. `schemas/*.xml` and `schemas/gschemas.compiled` land in the **same** commit (GNOME
  50 no longer compiles schemas shipped by extensions). Defaults must equal the behaviour the
  extension had before the key existed, so a fresh install still needs no configuration.
  `max-per-source`'s upper bound is native `MAX_NOTIFICATIONS_PER_SOURCE` and must not be
  raised above it.
- **A handler registered from settings is a cleanup obligation.** Every `changed::` id goes
  into `_settingsHids` and `disable()` disconnects each one — same rule as every patch point.
- **`prefs.js` may only use Adw/Gtk members that exist on this machine.** libadwaita 1.9.1 has
  no `subtitle` on `Adw.EntryRow` / `Adw.ButtonRow` and `Adw.SpinRow` has no `value-changed`
  signal (its `value` is a `double`, so an `int` key cannot be `bind()`-ed to it). Add every
  used member to `tests/check-prefs-props.js` and run `npm run check:prefs`; that gate exists
  because a missing property is a runtime warning the harnesses cannot see.
- **Logging discipline**: one line for enable, one for disable, a line or two when a switch is
  flipped — never per notification, never a notification body.

## Proving things
- **Red before green.** Write the assertion, run it against the pre-change tree
  (`git archive HEAD | tar -x -C /tmp/…`), see it fail, then make it pass. An assertion that
  cannot fail is not an assertion.
- **Prove the assertion is wired to behaviour, not to the code shape.** For anything that
  gates a user-visible behaviour, add a mutation to `tests/provoke-settings.sh` (break the
  live path in a /tmp copy; the named assertion must go red). Beware **equivalent mutants**:
  if a mutation survives, check whether another path already produces the same result before
  declaring the assertion vacuous — that has happened here and the correct answer was a
  different mutation, not a weakened assertion.
- **Assert on the side the outside world sees.** When we trim a stack we set a
  `NotificationDestroyedReason` *inside* the shell and the sender is told by a
  `NotificationClosed` message on the bus; only the second is a promise to a user, and an
  in-process reading stays green if the mapping in `notificationDaemon.js` is wrong. The bus
  never delivers a broadcast back to its own sender, so subscribing from inside the shell is
  empty **forever** — the harness starts a separate `dbus-monitor` on its private bus. A
  capture count of 0 is an instrument failure, never a pass, so the FAIL text prints the
  count. And attribute carefully: only the L1 notifications prove the trim produced that
  reason, because they are `urgency=critical` and cannot expire on their own — in a real
  session an expired notification reads identically.
- **A restoration check compares identities, never a log line, a line number, or
  `hasOwnProperty`.** Assert `obj.method === theFunctionCapturedBeforeEnable`. Restoring an
  own property re-assigns the same function, so "own property is gone" reads as failure;
  judging from `disabled, restored patches: …` text reads as success even when a wrapper is
  still live. Harnesses that count occurrences of `extension.js:1\d\d` stopped guarding
  anything the moment those wrappers moved past line 199.
- **Every new patch point gets its restore assertion in the same change.** Not in a follow-up.
- **Leak judgements use `GObject.signal_handler_is_connected` and own-property presence.**
  Never `WeakRef` + `imports.system.gc()`: measured on this machine that GJS does **not**
  collect the GObject wrapper that way, so a `deref()` that returns null proves nothing about
  the extension and a leak would read as fixed. `GLib.get_name_owner` does not exist in GJS.
- **A check must enter the branch it claims to cover, and must be provoked** — and beyond
  going red, it needs a green control case, otherwise "always red" is mistaken for "working".
- Aggregate numbers (assertion counts, test counts) are printed by the command that produces
  them. Never hand-copy one into a document, a comment, or a CHANGELOG `Evidence` line.
- When fixing a bug, the regression test must **fail against the pre-fix code**.

## Tests
- `npm test` — Node only, no shell: engine unit tests **plus** the repository-level guards
  (bilingual doc pair, zero-timer grep, patch-point ownership, no-Gtk-in-shell-process,
  records-free-of-app-names, `reports/` untracked). `node tests/test-groupEngine.mjs` and
  `node tests/repo.test.mjs` remain runnable bare and must stay dependency-free.
- `npm run check` — `node --check` over every shipped JS file. `npm run check:prefs` — the
  Adw member gate (needs `gjs`, no shell). `npm run check:log` — CHANGELOG coverage gate.
- `npm run pack` — build the installable zip **and** gate its contents (needs the
  `gnome-extensions` CLI, so it is a local step; `npm test` guards the manifest instead).
- `npm run verify:headless` (`tests/headless-verify.sh`) — runtime assertions in a throwaway
  GNOME Shell: `dbus-run-session` + `GSETTINGS_BACKEND=memory` + private `XDG_DATA_HOME` +
  unique `--wayland-display` + `--headless --virtual-monitor`. It must stay isolated — never
  point it at the live session or drop the memory backend. `tests/headless-verify.sh <dir>`
  runs it against a different tree, which is how the pre-change comparison is done.
- `npm run verify:ui-guard` — provocation bench; `EXPECT=guarded`/`EXPECT=native` must give
  opposite verdicts, and both are asserted by exit code rather than by a human diff.
- `npm run verify:provoke` — mutation bench. Its scope is "any gate that could stay green
  while the implementation idles": the four settings keys, when the trim runs, and the reason
  we hand the sender. Each mutation must turn its named assertion red.
- `npm run bench` — engine throughput. It prints numbers and asserts nothing, so it is not in
  `npm test`; run it after touching `computeGroup()`, because grouping runs on the
  notification hot path and a regression there is user-visible as input lag.
- Verification tiers are defined by what a claim needs, not by which tool ran: **L0** Node
  only, **L1** throwaway shell, **L2** the user's real session — which nothing here can
  automate. `MAINTENANCE.md § 三层验证边界` lists what each tier cannot see.
- The suite needs `tests/fixtures/`. Fixture provenance must stay free of private toolchain
  paths **and of real application names** — the pid and hint structure are the evidence.

## CI
- CI runs exactly two commands and both must stay green: **`npm test`** (L0: engine plus
  repository guards — no shell, no dependencies) and **`npm run check:log`**.
  `.github/workflows/ci.yml` runs them on `ubuntu-latest`, Node 20, on every push and PR.
  The L1 harnesses need a Wayland-capable session and are **not** in CI; that is a decision,
  not an oversight.
- `check:log` walks `git log <anchor>..HEAD`, so CI checks out with **`fetch-depth: 0`**.
  A shallow clone would not contain the coverage anchor and the check would fail for the
  wrong reason; keep that setting.
- A red CI is never made green by widening a skip list or loosening an assertion. Fix the
  cause, or move the change outside the declared coverage window.
- **Keep CI in step with the code.** Update `.github/workflows/ci.yml` in the *same change*
  that makes it stale — never as a later cleanup. New or renamed tests need no CI edit as
  long as CI runs the suite command; only touch CI if the *command itself* changes, or the
  environment does (a new dependency, a Node bump, a new system tool).
- **Renamed or moved code**: `check:log` watches a declared list (`CODE_PATHS` in
  `tests/check-log.mjs` — `extension.js`, `groupEngine.js`, `uiWorkarounds.js`, `prefs.js`).
  If a watched file moves, update that list in the same change; the check goes red until you do.
- **After a refactor**, confirm CI still exercises the real code and that the declared paths
  still cover it. A green CI that no longer touches the changed code is worse than a red one.
- If what CI runs changes, update this section too. CI is a signal, not a gate, until branch
  protection is enabled — read the result after every push.

## Release / version
- **Never release a bundle the gate has not produced.** Use `npm run pack`
  (`tests/pack.sh`), not a bare `gnome-extensions pack`. Measured on this machine's GNOME 50
  tooling: the packer auto-includes only `metadata.json` / `extension.js` / `prefs.js` /
  `stylesheet*.css`, so every module split out of `extension.js` is dropped **silently**
  (exit 0) and the resulting extension cannot even import its engine. It ships
  `schemas/<id>.gschema.xml` but never `schemas/gschemas.compiled` — that is the file
  `Gio.SettingsSchemaSource.new_from_directory()` opens, and a directory-installed extension
  normally has it generated for it (every third-party extension here has a compiled newer than
  its `.xml`); we ship ours so **the bundle equals the source tree** that `git clone` installs.
  `--schema=` and a directory `--extra-source` both fail and still exit 0;
  `--extra-source=schemas/x.compiled` lands the file at the zip **root**.
  `tests/pack.sh` adds what the packer cannot and refuses to emit a bundle missing any runtime
  file, so the manifest is the only place the list lives, and `npm test` (which is what CI can
  run — no `gnome-extensions` on runners) fails if a new local import is not declared there.
- **`gnome-extensions install <zip>` is not an instrument on this box.** Measured: it prints
  "Can't recursively copy directory" for *every* zip, including a flat two-file one, exits 0,
  and installs nothing. Never cite it as evidence that a bundle does or does not work.
- **The installable artifact gets its own L1 run**: extract the produced zip and run
  `tests/headless-verify.sh <extracted-dir> <label>`. The source tree passing proves nothing
  about the bundle (the undeclared bundle measured 2/41 while the tree ran 41/41).
- The shipped version is the integer **`version`** field in `metadata.json` — the only place
  the number lives; nothing else hardcodes it.
- Bump it when a change ships to users, **in its own commit** (precedent: `meta: version 5→6`).
  Tests, docs and tooling that ship nothing do not bump it.
- `CHANGELOG.md` entries carry a `· vN` marker; keep it consistent with the bump you make.

## Docs & commits
- `README.md` and `README.zh-CN.md` are one document in two languages; keep both in sync with
  code changes (`npm test` asserts the section count and the language switcher). User-facing
  strings and docs are English-first in the public places (repo About, settings labels);
  Chinese where the repo already pairs them.
- Commit code first, docs in a separate commit. Messages use **Chinese subjects with English
  conventional-commit prefixes** (`fix:` / `perf:` / `test:` / `docs:` / `chore:`).
- **Stage explicit paths.** Never `git add -A` or a whole directory: that sweeps the
  maintainer's own unrelated pending deletions into your commit. Check `git status` after
  staging, and re-read the commit afterwards.
- Live logs: `journalctl --user -b | grep -i notification-grouper`

## Recording conventions
- Behaviour changes land in `CHANGELOG.md` as `D-###` entries. Ids are monotonic and
  **never reused**, so a gap in the numbering means an entry was deleted — `check:log` treats
  it as a failure rather than a cleanup.
- `kind` ∈ `fix` | `perf` | `taste` | `guard` | `revert` | `chore`, cut by **who may demand a
  revert**: dropping it makes a bug → `fix`; dropping it only re-introduces measurable
  degradation → `perf`; dropping it only annoys me → `taste`. A change that is both splits
  into two entries. A withdrawal is recorded too — a log without reverts reads like a victory
  list. Cleanup owed nothing either way is `chore`.
- **A `revert` must name the `D-###` it overturns.** Partial overturns count: the settings
  surface reopens what D-001/D-002 closed, so it cites them instead of pretending it is new
  work. A change that silently undoes an earlier decision is the failure mode this whole file
  exists to prevent.
- An entry is an assertion **as of its commit**, not current state. Do not re-verify old
  entries; do not hand-copy an aggregate count into the file — `npm run check:log` prints them.
- Known-but-not-fixed issues do **not** go in `CHANGELOG.md` — they have no commit, because
  nothing was touched. They live in README § What it does not do and § Known limitations, and
  in `MAINTENANCE.md § 已知不修`.
- `Symptom` names the mechanism, never the session: no desktop app names, no notification
  bodies, no private toolchain paths (same rule as fixture provenance above).
- Run `npm run check:log` before committing docs. It fails on any commit inside the declared
  coverage window that touched a watched code path without being cited by an entry. Deliberate
  scope-outs belong outside the window, never inside an ad-hoc skip list.
