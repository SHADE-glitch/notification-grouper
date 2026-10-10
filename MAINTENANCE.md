<p align="right"><a href="MAINTENANCE.md"><b>English</b></a> | <a href="MAINTENANCE.zh-CN.md">简体中文</a></p>

# MAINTENANCE — notification-grouper@local maintenance manual

**Reading order**: `reports/STATE.md` (if present, this round's continuation point; the directory is gitignored) → `AGENTS.md` (rules)
→ this file (facts and manual) → `CHANGELOG.md` (decision history).

This file holds only **reviewable facts and fixed procedures**; no rules (rules live in
`AGENTS.md`), no decisions (they live in `CHANGELOG.md`). All native line numbers come from
`gresource extract` on this machine's GNOME Shell 50.1, and every section below notes its
verification date; line numbers drift across versions, so references always give a **range**
rather than a single line.

- Code size: `extension.js` 395 / `groupEngine.js` 159 / `uiWorkarounds.js` 206 /
  `prefs.js` 206 lines (shipped code totals 966 lines; the rest is tests and docs).
- Native JS is not on disk under `/usr/share/gnome-shell`; it lives in the gresource of
  `/usr/lib/gnome-shell/libshell-18.so`; the subcommand is `extract`, not `show`.

```sh
gresource list /usr/lib/gnome-shell/libshell-18.so | wc -l        # 160 entries on this machine
gresource extract /usr/lib/gnome-shell/libshell-18.so \
  /org/gnome/shell/ui/messageList.js > /tmp/ml.js
```

## Invariants

Violating any one of these is a bug, not a style issue. Each one notes "who guards it" — an
invariant with no guard is as good as none.

- **Every one of the three patch layers must detach-before-capture, and detach after its own
  await.**
  Guard: L1 `double-enable restores pristine` / `re-attach after detach` /
  `guards restored to pristine` (the prototype layer is judged by **identity-equal to the
  function captured before enable**, not by log text, not by line number, not by
  `hasOwnProperty`). History: v4 fixed this only for the two daemon layers (D-005); the other
  two were not added until this round (F1) — the 504-frame recursion accident back then
  happened only at the daemon layer, because the other two layers, on a second enable, were
  **stacked** rather than self-invoked.
- **`enable()` must not reset state it owns.** `_shared` / `_ownSources` register overrides
  and connections already attached to other objects; rebuilding them = nobody can restore
  them. Guard: L1 `record survives re-enable`, `own-source survives re-enable`,
  `destroy handler detached`.
- **`disable()` must be able to undo everything `enable()` did**, including the four
  `changed::` handlers and the own merged source itself. Guard: L1
  `disable disconnects settings`, `disable drops the settings object`,
  `merged source destroyed on disable`, `native pid cache self-cleaned`.
- **Eviction must never empty the merged source.** Native calls `this.destroy()` on the whole
  source when the source's last notification is destroyed (`messageTray.js:569-570`), so
  "evict to cap-1 before push" at `cap=1` makes the immediately following native
  `addNotification` operate on an already-disposed object. Guard: L1
  `cap=1 keeps one card, still one source` and `no repeated extension.js frame` (the latter's
  red is exactly the stack of those two Gjs-CRITICALs).
- **Zero timers, zero periodic tasks**: structurally zero idle overhead is this extension's
  cost model. Guard: L0 `no timer or repeating source in the shipped code` (grep all shipped
  JS).
- **The hot path does no IO, uses no regex, and reads no settings**: settings are read once
  into memory and refreshed by `changed::`. Guard: `npm run bench` (throughput, not an
  assertion) + code review.
- **Degradation is isolated by category**: missing either daemon point → fully inert;
  `messageList.js` unreachable → only the fallback is lost. Guard: L0 `checkAttachPoints` /
  `checkUiGuardPoints` unit tests + L1 `patches installed on enable`.
- **The shell process imports no Gtk/Gdk/Adw** (`prefs.js` is the sole exception; it runs in
  a separate GTK4 process). Guard: L0 `no Gtk/Gdk import in the shell process…`, and the same
  assertion inversely requires that `prefs.js` really imports Adw, otherwise this guard could
  be quietly defeated by "renaming prefs.js".
- **Logging discipline**: no per-notification log, never log the body; aggregate numbers are
  printed by the command that produces them and never hand-copied into docs. Guard: L0
  `records carry no real application name`, documentation review.

## The three verification layers

| Layer | Command | Environment | What it can prove |
| --- | --- | --- | --- |
| L0 | `npm test`, `npm run check`, `npm run check:log` | Node only | pure-function behavior, repo-level invariants, CHANGELOG coverage |
| L0.5 | `npm run check:prefs` | `gjs` + libadwaita introspection, no shell | every Adw/Gtk member used by `prefs.js` exists on this machine, and disabled members are not used |
| L1 | `npm run verify:headless`, `npm run verify:ui-guard` (both `EXPECT` modes), `npm run verify:provoke` | a one-shot headless GNOME Shell (private D-Bus + `GSETTINGS_BACKEND=memory` + private `XDG_DATA_HOME` + separate `--wayland-display`) | patch attach and restore, merge semantics, source destruction, settings hot-application, whether the fallback really catches the native defect, **whether the eviction reason told to the sender really reached the bus** (a separate `dbus-monitor` on the same bus) |
| L2 | the `tests/smoke.sh` checklist, run by the user in a real session | the user's desktop | real senders' (CLI hook / systemd / tools with `--app-name`) behavior, look and feel, light/dark, the prefs dialog's actual rendering |

**What L1 cannot see** (written here so you don't use it as evidence):

- Real power draw. headless has no compositor scanout, no GPU involvement, no screen refresh;
  the measured CPU/RSS change can only prove "no extra resident task", not "power saving".
- Frame clock and animation: `--headless --virtual-monitor` does not produce real `stage`
  drawing.
- **The prefs dialog itself**: `prefs.js` runs in a D-Bus-activated separate GTK4 process
  (`/usr/bin/gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions`), and the headless
  shell does not start it. Widget properties can pass the L0.5 introspection gate, but "how
  this row renders on 1.9.1" and "whether EntryRow accepts input" can only be seen by hand at
  L2.
- Real senders' identity resolution: in headless every notification is of the `notify-send`
  kind; senders that resolve to a `Shell.App` never take the patched path at all.
- Cross-minor-version compatibility (only knowable by re-running L1 on the target version).

**Three instrumentation rules on the L2 side** (each corresponds to a real misreading):

- **To see what the sender receives, you must start a separate listening process.**
  `NotificationClosed` is broadcast by the shell itself, and the bus does not deliver a
  broadcast signal back to the sender, so subscribing inside the shell process is always
  empty — that is a green of the kind "the instrument was never connected, yet it looks like
  the product is fine". The headless harness already has `dbus-monitor` built in. Also:
  **catching reason 1 in a real session cannot be attributed to eviction**, because an
  ordinary timeout notification naturally expiring reads exactly the same; attribution holds
  only at L1, where the notification is `urgency=critical` (it does not disappear on its own,
  so the only source is eviction).
- **To judge which code the live session loaded, compare start time against mtime**:
  `ps -o lstart= -p $(pgrep -x gnome-shell)` and `date -r extension.js`. Do not use
  `gnome-extensions info` — it reads the on-disk `metadata.json` and does not reflect the
  loaded class; disable/enable also does not reload ES modules.
- **A generic string cannot be a product criterion.** `already disposed` is a generic string
  in GNOME: a single boot produced 5 of them in testing, all noise from `St.Adjustment` /
  `Gjs_ui_layout_UiActor` in the second the shell restyles. Our defect's characteristic
  string carries a class name, so the criterion must be written out in full:
  `notificationDaemon_FdoNotificationDaemonSource` (`smoke.sh` already does this).

## Shell internal interface inventory (measured on 50.1, verified 2026-10-09)

The `Extension side` column gives only a **symbol anchor** (function name / assigned value),
not a line number in this repo — this repo's line numbers drift every round, while the symbol
name is what `npm test` verifies (`every declared patch point is still named in the module
that owns it`), so a drift turns red.
The `Native side` column is where line-number ranges go (we don't control it), and **before
changing any line, re-run the `gresource extract` above to re-verify**; don't trust that this
table is still fresh.

| # | Dependency | Extension side | Native side (50.1) | Nature |
| --- | --- | --- | --- | --- |
| 1 | `Main.notificationDaemon._fdoNotificationDaemon` | `_attach()` reads `daemon._fdoNotificationDaemon` | `notificationDaemon.js:714` | private property, no public accessor |
| 2 | `NotifyAsync(params, invocation)` | `fdo.NotifyAsync = …` in `_attach()` (restored by `_detachPatches()`) | defined at `:135`; hints read at `:166-167`; **synchronous**, zero `async`/`await` in the whole file | private method; `_pending`'s single-slot assumption rests entirely on this line |
| 3 | `_getSourceForPidAndName(sender, pid, appName)` | `fdo._getSourceForPidAndName = …` in `_attach()` (restored by `_detachPatches()`) | defined at `:113`; native self-cleans `_sourceForPidAndName` at `:126-128` | private, three-arg signature |
| 4 | hints `x-shell-sender-pid` / `x-shell-sender` / `desktop-entry` | the `read()` helper inside the `NotifyAsync` wrapper (reads `desktop-entry`, `x-shell-sender-pid`) | injected by a separate process `/usr/bin/gjs -m /usr/share/gnome-shell/org.gnome.Shell.Notifications` (that side **is** async), read on the shell side at `:166-167` | protocol convention, not an API |
| 5 | `FdoNotificationDaemonSource.open()` → `openApp()` + `destroyNonResidentNotifications()` | for an own source, `source.open = patchedOpen`; `disable()` restores by `rec.origOpen` | `notificationDaemon.js:370-373` (base class `messageTray.js:612`); when `activated` provides no default action it takes `source.open()` `notificationDaemon.js:232-241` (`:239`) | **instance-property** override, affects own sources only |
| 6 | `Source`'s `destroy` signal | for an own source, `source.connect('destroy', …)`; the id is stored in the `_shared` record | declared at `messageTray.js:513`, emitted at `:605` | public signal, the only supported way to observe a source's lifecycle |
| 7 | `Source.destroy()`'s resource release | called by `disable()` | `messageTray.js:597-609` (`policy.destroy()` `:607`, `run_dispose()` `:608`); `FdoNotificationDaemonSource.destroy()` `notificationDaemon.js:384-391` calls `unwatch_name` first, **and does not forward a reason** | the basis for destroying own sources on disable |
| 8 | `Message.prototype.unexpand(animate)` | `Message.prototype.unexpand = …` in `attach()` (`detach()` restores by `_origUi`) | `messageList.js:644`, where `:646`'s `ease_property('@layout.expansion')` is exactly the **ordinary function** `_easeAnimatableProperty` at `ui/environment.js:196` | an exported class's prototype (dynamic `import()`) |
| 9 | `NotificationMessageGroup.prototype.collapse()` | `Group.prototype.collapse = …` in `attach()` (restored by `detach()`) | `messageList.js:988-1009`: `forEach` `:992`, `_expanded=false` `:998`, `_cover.show()` `:1000`, the only `.catch()` at `:1006` (after the loop, can't catch it) | same as above |
| 10 | `NotificationMessage.prototype.close` | `NotificationMessage.prototype.close = …` in `attach()` (restored by `detach()`) | **inherited only**: the real body is `Message.close` `messageList.js:541`; `NotificationMessage` has no own `close`; the default handler `on_close` `:726` | see F5: upstream changing `Message.close` will affect this layer too |
| 11 | `Message._bodyBin` / `._expanded` / `Group._cover` / `expanded` getter | inside `uiWorkarounds.js` | `messageList.js:512`, `:909`, `:904`, `:952` (a single-card group reports `expanded===true`) | private fields, the fallback's criteria |
| 12 | close in a collapsed group upgraded to closing the whole group | the fallback's trigger condition | `messageList.js:1107-1112` (`signal_stop_emission` `:1110`, `this.close()` `:1111`); clicks swallowed at `:1114-1119` (`if (!this.expanded)` `:1115`) | known upstream behavior, not the defect itself |
| 13 | `MAX_NOTIFICATIONS_PER_SOURCE = 10` | the `NATIVE_MAX_PER_SOURCE` constant + `_evictTo()` | `messageTray.js:25`; native evicts synchronously **before push** at `:577-579`, reason `EXPIRED` (enum `:48-53`) | the source of the `max-per-source` setting's upper bound |
| 13b | **Source self-destroys when its last notification is destroyed** | this is why eviction can only be placed **after** push | `messageTray.js:569-570`: `if (!this._inDestruction && this.notifications.length === 0) this.destroy()` | hard constraint: `_evictTo(…, 0)` makes the immediately following native `addNotification` (`:592`) operate on an already-disposed object; measured `Gjs-CRITICAL … has been already disposed`, stack `notificationDaemon.js:266 → :367 → messageTray.js:592` |
| 14 | destroy reason → FDO `NotificationClosed` | not touched | `notificationDaemon.js:178-195` (EXPIRED→1 / DISMISSED→2 / SOURCE_CLOSED→3 / others→4), emitted at `:300-302` | passing the wrong `EXPIRED` = "manually closing" on the user's behalf; see the `_evictTo` comment |
| 15 | `ExtensionBase.getSettings(schema)` | `this.getSettings()` in `_loadSettings()` | `extensions/sharedInternals.js:92`; `metadata.json` needs `settings-schema`; GNOME 50 **no longer** auto-compiles an extension's bundled schema (zero `compile_schemas` in `extensionUtils.js`/`extensionSystem.js`) | public API (extension framework) |

**One practical note on settings** (measured on this machine): the schema the extension uses
exists only in the extension directory's `schemas/`, and `getSettings()` attaches it in place
via `Gio.SettingsSchemaSource.new_from_directory(...)` (`sharedInternals.js:97-105`). So
**CLI tools** like `gsettings list-recursively <schema>` / `gsettings get` **cannot see it**,
but the dconf **path** written is the same — to see the values in a real session, use
`dconf dump /org/gnome/shell/extensions/notification-grouper/` (read-only). This also means:
harness writes under `GSETTINGS_BACKEND=memory` do not land here, while any `gsettings set`
run in a real session **will** change the user's actual configuration — don't type it casually
while troubleshooting.

## Compatibility matrix

| GNOME | Status | Basis |
| --- | --- | --- |
| 50.1 / Ubuntu 26.04 | **verified by running (R)** | all anchors in this file, both L1 harnesses, the full L0 suite |
| 50.2+ (same major version) | loads as usual, unverified | GNOME's compatibility check compares only the major version; the risk is concentrated in the two private method names #1/#3 in the table above |
| 48 / 49 | looks source-compatible, **not declared** | never run; `shell-version` deliberately not listed |
| 51+ | unknown | don't guess before release; `checkAttachPoints` will make it go inert and log a single line |

Failure modes are part of the design: upstream renames → the extension goes fully inert + one
`WARNING degraded, staying inert` line, no exception thrown, no notification dropped;
fallback unreachable → only the fallback is lost, grouping proceeds as usual.

## Upgrade adaptation manual

When a new minor version (or a new distro) arrives, do the following in order; don't skip
steps:

1. **Fetch the source**: `gresource extract` `notificationDaemon.js`, `messageTray.js`,
   `messageList.js`, `ui/environment.js`, `extensions/sharedInternals.js`.
2. **Re-verify the table row by row**, focusing on three fatal items: whether `NotifyAsync`
   is still **synchronous** with no `await` (#2; `_pending`'s single slot rests entirely on
   this), whether `_getSourceForPidAndName`'s **three-arg signature** is still there (#3), and
   whether `Source.destroy()` still releases `policy` and `watch_name` (#7). If any fails →
   change the design before changing the code; don't "just run it and see".
3. **Run L1**: `npm run verify:headless`. Only all-green allows talking about compatibility;
   if there is red, first decide "is the implementation broken or is the assertion stale"; the
   criterion is the assertion's semantics, not its color.
4. **Run the fallback provocation bench**: `EXPECT=native` (the copy with the fallback off)
   and `EXPECT=guarded` must give **opposite** conclusions. If native mode no longer
   reproduces the defect, upstream has fixed it — that's good news; delete the fallback
   wholesale per the nine-file list in `uiWorkarounds.js`'s header.
5. Only once steps 3 and 4 are both green, discuss relaxing `shell-version`; list only
   versions actually run.
6. **Run the release artifact through L1 separately**: `npm run pack` produces the zip (it has
   its own content-integrity gate); after unpacking, `tests/headless-verify.sh <unpacked-dir>
   bundle` must likewise be all green. A green source tree **does not equal** a green zip:
   GNOME 50's `gnome-extensions pack` is a C program that collects only fixed filenames
   (`metadata.json` / `extension.js` / `prefs.js` / `stylesheet*.css`), so split-out modules
   are **silently dropped with exit 0**. On the schema side it collects only
   `schemas/<id>.gschema.xml`, not `schemas/gschemas.compiled` — and it's the latter that
   runtime `new_from_directory()` opens (with only the .xml present it throws directly in
   testing), while a directory-installed extension usually has it generated in place by the
   installer (all four third-party packages on this machine have a `gschemas.compiled` mtime
   later than the same-named .xml); we pack it into the zip so that **the artifact equals the
   source tree** (a `git clone` install is exactly the source tree), not because missing it is
   fatal. `--extra-source=schemas/gschemas.compiled` puts it in the zip root directory (wrong
   path = not included), and `--schema=schemas` reports "Can't recursively copy directory" and
   still exits 0. **Don't use `gnome-extensions install <zip>` as a verification instrument**:
   measured on this machine, it reports that line for any zip (including a flat two-file
   package), exits 0, and installs nothing.
7. Write each step's result into `reports/STATE.md`; conclusive behavior changes go into
   `CHANGELOG.md` (`D-###`).

## Fixed measurement methods for power draw and leaks

**Idle overhead**: structurally zero — no timer, no watch, no repeating task; the extension
runs only when a notification arrives. The executable proof is L0's grep guard (any
`timeout_add`/`idle_add`/`setTimeout`/`setInterval` appearing in shipped JS fails
immediately), **not** "it looks like it isn't moving".

**Leak criteria** (deterministic; GC probing forbidden):

- Signals: `GObject.signal_handler_is_connected(obj, id) === false` (verified usable this
  round; `GLib.get_name_owner` **does not exist** in GJS).
- Per-source override: `obj.open === native function` (identity comparison), plus the
  extension's own `_shared.size === 0`.
- Prototype layer: identity-equal to the function captured before enable.
- **Forbidden**: `WeakRef` + `imports.system.gc()` — measured on this machine, that cannot
  collect a GObject wrapper, and `deref()` still returns a live object — using it to judge
  leaks reads a real leak as fixed.

**RSS sampling** (trend reference only, not a criterion): `tests/headless-verify.sh` reads
page 2 of `/proc/self/statm` at four points — baseline → after a notification burst → after a
second enable → after everything is disabled — and prints them as-is (the fourth point is not
sampled if the settings phase throws early, and prints as `(not sampled)`). It **participates
in no assertion and does not affect the exit code**, because in the same process the noise
from fonts, icons, and GPU caches is far larger than the extension itself; treating it as a
red criterion is measuring noise. This round's measured values are recorded in
`reports/VERIFY.md`.

**Only L2 can talk about "power saving"**: the only comparison in a real session is "on vs
off", running a session for each, watching `journalctl` for anomalies and the notification
list for stutter; don't pass off headless numbers as this conclusion.

## Known but not fixed

These all have records and cost analysis and are deliberately left alone. Don't "optimize them
in passing".

- **Not rebuilding TTL / clear-group button / group-header title override** (D-003 holds):
  those are behavior rewrites, not grouping.
- **Looking up the sender's identity via `/proc`**: rejected (user decided). The ceiling of
  grouping capability is the protocol layer — isolating by pid when the sender declares no
  `app_name` is correct, and the only fix is for the sender to carry `--app-name` itself.
- **Raising the cap above 10**: would require duplicating native `addNotification` (destroy
  old entry + two connects + push + `countUpdated`), adding a fourth fragile patch point for a
  low-frequency benefit — not worth it. Written into README § What it does not do.
- **The cause of `_removeNotification`'s dirty entries** (`messageList.js:1152/:1161/:1170`):
  the root cause is upstream; this extension only catches it downstream and does not rewrite
  the native delete path.
- **The three fallbacks as one degradation unit** (F5): `NotificationMessage.prototype.close`
  is merely inherited, so once upstream touches `Message.close` it drags the two unrelated
  collapse fallbacks into degradation as well. This round **keeps** this coupling (splitting it
  would require per-point independent capture/restore, and the benefit is theoretical); it's
  only written into the list; on a real incident, delete wholesale per the list in
  `uiWorkarounds.js`'s header.
- **`_pending`'s synchronous handoff may fail under a cross-distro patch**: the two existing
  guards (pid, `app_name`) fall on the safe side — pass straight through to native + a one-time
  warning. It was not changed to per-invocation state, because that needs await semantics, and
  `NotifyAsync` currently has none.
- **The prefs widgets' usable properties only passed the introspection gate** (L0.5);
  rendering and interaction are M (require the user to confirm in a real dialog).
