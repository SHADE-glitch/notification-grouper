# CHANGELOG — notification-grouper@local

Original extension, **no upstream**: there is no fork point to diff against, so the record
starts where the current architecture was settled rather than at a snapshot of someone
else's code.

Coverage: 257d84f..HEAD
Check with `npm run check:log`. Entries are `D-###`, monotonic, never reused.
An entry states what was true **as of its commit**, not current state: old entries are not
re-verified, and aggregate counts live in the checker's output, never in this file.

`revert` = a deliberate withdrawal of earlier work; dropping it is a decision, not a bug.
Known-but-not-fixed issues do **not** appear here (they have no commit) — see README
§ What it does not do and § Known limitations.

---

### D-001 · 2026-09-26 · revert · v2
Symptom  The preferences surface depended on specific libadwaita widget properties; on 1.9.1
         `Adw.ButtonRow` / `EntryRow` have no `subtitle` (`ddc3094` hit this in practice, and
         the workaround at the time was to use the Group description)
Change   Deleted `prefs.js` / `rules.json` / `rules.example.json` / `check-adw-props.py`;
         the extension became zero-config: no settings dialog, no rules file, no config key
Evidence L0 statically provable (these files do not exist in HEAD); L1 re-run all green on
         2026-10-07; L2 unverified
Cost     Restoring it means overturning the "zero-config" positioning, not restoring a
         piece of code
Commit   257d84f

### D-002 · 2026-09-26 · revert · v2
Symptom  The engine carried `compileRules` plus rule fields such as `sourceRules` /
         `blockRules` / `bodyPattern` / `urgency` / `groups`; these only make sense given a
         whole set of rules files and a validation path
Change   Slimmed down to three pure functions `normalizeName` + `computeGroup` +
         `checkAttachPoints`; all rule fields removed
Evidence L0 statically provable (`compileRules` and `rules` both have 0 hits in the two
         source files in HEAD); L1 re-run all green on 2026-10-07; L2 unverified
Cost     Same batch as D-001: restoring rule capability means restoring an already-deleted
         preferences surface
Commit   e0872b3

### D-003 · 2026-09-26 · revert · v2
Symptom  The extension once carried a third daemon patch, a clear-group button, TTL expiry,
         and a group-header title override
Change   Returned to 2 patches + native behavior; the four items above were deleted and
         handed back to native GNOME
Evidence L1 re-run all green on 2026-10-07 (of which "native cached one pid per group"
         still holds); TTL and group-header override have 0 hits in HEAD; L2 unverified
Cost     What was deleted is a feature, not a defect; adding it back means changing the
         "patch only, don't change behavior" positioning
Commit   2df3f29

### D-004 · 2026-09-29 · fix · v4
Symptom  The FDO backend caches the source by `pid + app_name`; command-line and dev tools
         get a brand-new pid each time, so notifications from the same origin scatter into a
         pile of separate cards. Previously generic `app_name` values (`notify-send` etc.)
         were let straight through
Change   Changed the grouping key to the identity the sender **declares**; the batch that
         declares a generic name now also participates in grouping
Evidence L1 re-run all green on 2026-10-07 ("group keys as declared", "3 same-name pids
         merged"); L2 sender-side `-a` was verified working (README § How it works)
Cost     Consider the boundary together: senders that declare no name at all are still let
         through; this entry only changes the batch that declares a generic name
Commit   491f744

### D-005 · 2026-10-01 · fix · v4
Symptom  When `enable()` runs without a prior `disable()`, the second `_attach()` captures
         the wrapper layer itself as the original method, forming
         `wrapper2 -> wrapper1 -> wrapper1`; headless testing reproduced this as 504 layers
         of recursion at `extension.js:141`, and every notification was lost in that run
Change   `_attach()` now calls `_detachPatches()` before capturing `_orig`, so `_orig`
         doubles as the single flag for "am I currently patched"
Evidence L1 re-run all green on 2026-10-07 ("double-enable restores pristine", "re-attach
         after detach", "no wrapper recursion"); L2 unverified
Cost     Removing idempotency throws no error, it just silently drops notifications; it
         cannot be changed separately from the restore logic in `disable()`
Commit   f10a7ea

### D-006 · 2026-10-01 · fix · v4
Symptom  `_pending` was validated by `pid` alone. When one sending process fires two
         notifications with different `app_name` back to back, the pid is the same, so they
         get merged into the wrong group and rewrite the stack title — the pid guard can't
         see this interleaving
Change   Also record the original `params[0]`; `_getSourceForPidAndName` falls back to the
         native path when the two disagree
Evidence L1 re-run all green on 2026-10-07, but "app_name guard silent" is a **negative
         assertion** — it only proves the guard should not fire in the normal case, not that
         behavior is correct when it does fire; a `pending-appname-mismatch` in the journal
         means the synchronicity assumption has broken; L2 unverified
Cost     Removing the second field check throws no error, it just silently mis-merges; this
         is the hardest part of this entry to spot
Commit   57f2661

### D-007 · 2026-10-07 · fix · v5
Symptom  GNOME 50.1 `messageList.js`'s `_removeNotification` reads `item.layout_manager` at
         :1161, but only deletes the mapping in the animation `onComplete` (:1170): if it
         throws in between, an orphan message is left behind. `collapse()` (:988) iterates
         onto it at :992, `Message.unexpand` (:644) at :646 calls
         `ease_property('@layout.expansion')`, and `ease_property` is just the ordinary
         non-async function `_easeAnimatableProperty` (ui/environment.js:196) ⇒ the
         `TypeError` is thrown synchronously; `collapse()` is `async` but has no
         `try/finally`, so the throw only turns its own promise into rejected ⇒
         `_expanded = false` (:998) and `_cover.show()` (:1000) do not run (the method's only
         `.catch()` is at :1006, belonging to the `ease_property_async` statement **after**
         the loop, so it can't catch this throw) ⇒ the group stays half-collapsed forever,
         and every later click is swallowed by the :1114-1119 branch; the tray looks dead
Change   Obtain `ui/messageList.js` via dynamic `import()`, add fallbacks to
         `Message.prototype.unexpand` and `NotificationMessageGroup.prototype.collapse`;
         only reroute when `_bodyBin.layout_manager` is null (actor already destroyed);
         restore them together with the two daemon patches in `disable()`;
         `_attachUiGuards()` checks `_enabled` after `await` before continuing
Evidence L1 2026-10-07 `verify:ui-guard` PASS (`collapseThrewToCaller=false`,
         `coverShown=true`, `TypeError(obj is null)` count 0); L2 unverified (the collapse
         path needs a real session)
Cost     Should be deleted wholesale once upstream fixes it — it's a defect fallback, not a
         feature. Why this extension carries it: grouping multiplies the cards, turning a
         defect native code can almost never hit into one that can occasionally be hit
         (README § Why an extension for grouping patches shell UI)
Commit   528b234

### D-008 · 2026-10-08 · fix · v7
Symptom  Clicking a notification that has no default action makes the native
         `FdoNotificationDaemonSource.open()` first call `openApp()` (this source's app is
         always null, effectively a no-op) and then `destroyNonResidentNotifications()`,
         wiping the whole source. Native caching by sender ≈ one card, so it's invisible;
         cross-pid merging widens the scope to an entire group, so "click one card -> list
         clears, calendar sits on a blank page, the whole group disappears"
Change   When creating an own source, override its `open()`, keeping only `openApp()` and
         dropping the bulk destroy; the clicked card is still dismissed by
         `Notification.activate()`'s `destroy()` for non-resident notifications. Native
         sources are untouched; `disable()` restores by each record's `origOpen` (the
         `source.open === rec.patchedOpen` guard prevents a wrong restore); when
         `source.open` is not a function, only warn without dragging down grouping
Evidence L1 2026-10-08 `verify:headless` all green (newly added "merged source recognised",
         "open() does not wipe the group": notification count unchanged after calling the
         shared source's open()); L2 unverified
Cost     Removing the override brings back "click one, wipe the whole group". It only
         affects the extension's own sources, so the cost of deleting it is confined to
         that scenario
Commit   eb0a0fa

### D-009 · 2026-10-08 · taste · v7
Symptom  Clicking a card's × in a collapsed group makes native `messageList.js:1107-1112`
         upgrade close into "close the whole group". Invisible when one native source ≈ one
         card; the cost is amplified after merging
Change   Only when "the source is an extension-owned source + the group is collapsed", run
         close's default handler `on_close()` directly instead (GJS auto-wires by
         `on_<signal>`, confirmed by testing), closing only the clicked card; native
         sources, expanded state, and single-card groups all take the native path
Evidence L1 2026-10-08 `verify:ui-guard` flips on the same harness between old and new
         builds: closing one card in a collapsed group, pre-fix 3 -> 0 (whole group),
         post-fix 3 -> 2 (only one closed); L2 unverified
Cost     taste level: deleting it just falls back to "click × closes the whole group", not a
         bug. It was still done because it shares a root with D-008 (merging amplifies
         native per-source behavior); changing them together is what makes it coherent
Commit   eb0a0fa

### D-010 · 2026-10-09 · fix · v8
Symptom  `enable()`'s idempotency **only holds for the two daemon methods**. It rebuilds
         `_shared` / `_ownSources` to empty before attach, while the own-source `open()`
         override and per-source `destroy` connections are registered only in those tables
         and restored only by `disable()` per record: a second enable that bypasses disable
         permanently orphans them (the `destroy` closure even captures the extension
         instance itself), and losing an entry from `_ownSources` makes the close fallback
         silently fall back to "close one = close the whole group". The prototype fallback
         has another spot: `detach()` is called **before** its own `await`, which amounts to
         not detaching
Change   Removed the three lines of state reset in `enable()` (keeping only pure bookkeeping
         fields); moved the fallback detach to after the await and before capture; re-check
         liveness after the await before allowing attachment
Evidence L1 2026-10-09 red then green: six assertions (record survives re-enable /
         own-source survives re-enable / merged open() restored / destroy handler detached /
         guards restored to pristine / disable log matches reality) all FAIL on the unfixed
         tree and all PASS after the fix. The actual run also falsified my static estimate:
         it stacks 4 layers, not 2 (4 enables → 4 "UI guards attached" lines), and
         `disable()` printed a complete "restored three fallbacks" **false report**; L2
         unverified (taking effect for real requires a logout)
Cost     Restoring any one reset line reintroduces orphaned patches; this cannot be changed
         separately from the restore logic in `disable()`
Commit   96ce1a0

### D-011 · 2026-10-09 · fix · v8
Symptom  The `open()` override removes only the **second half** of the native method, so
         after restoring native `open()` the `destroyNonResidentNotifications()` takes effect
         again — "click one card clears the whole group" returns **after disabling**; also,
         each own source holds a `Gio.DBus.watch_name` subscription and a
         `NotificationPolicy`, and nobody frees them unless the source is destroyed (a real
         leak, and the closure chain keeps the extension instance alive too)
Change   `disable()` calls `rec.source.destroy()` after disconnecting per-source signals and
         restoring `open()` by identity
Evidence L1 first added two assertions that produced
         `FAIL merged source destroyed on disable` / `FAIL native pid cache self-cleaned`,
         then implemented to green; native basis is `messageTray.js:597-609`
         (`policy.destroy()` + `run_dispose()`) and `notificationDaemon.js:384-391`. Also
         found along the way: `FdoNotificationDaemonSource.destroy()` neither accepts nor
         forwards a reason, so these cards are sent to the sender as `NotificationClosed`
         reason 4 (`undefined`) — accepted and written into the README, without adding a
         third patch point for it; L2 unverified
Cost     The cost is that the merged stack disappears entirely at the moment of disabling
         (the user explicitly chose B among the A/B/C options); removing destroy would also
         take back both the "still broken after disabling" fix and the leak fix
Commit   96ce1a0

### D-012 · 2026-10-09 · guard · v8
Symptom  Instrumentation green but blind: the recursion criterion `extension\.js:1\d\d`
         matches only lines 100–199, while the current wrapper body is after 278/315 — it
         does not guard the code it claims to; the fallback restore and per-source `open()`
         restore have **no assertion at all**; the restore criterion runs before the async
         attach completes, so it physically cannot see the fallback layer;
         `tests/headless-ui-guard.sh` has zero assertions (only cat JSON), and the required
         "flip" relies on a human running diff twice, so it can't enter the gate; signal
         leaks, leftover actors, and idle overhead are not measured at all
Change   All restore criteria changed to "identity-equal to the native function captured
         before enable"; leak criteria use `GObject.signal_handler_is_connected` and own
         properties (locally verified that `WeakRef` + `imports.system.gc()` cannot collect a
         GObject wrapper, so they are banned as probes); confirm the fallback is attached
         before judging; ui-guard now gates by exit code on `EXPECT=guarded|native`; added
         `tests/provoke-settings.sh` mutation bench; RSS samples four points and **only
         reports, never asserts**
Evidence All actually run: guarded and native sides each all green with opposite conclusions
         (3->2 and 3->0); the mutation bench's 6 mutations turned 6 corresponding assertions
         red; the baseline across three runs differed by about 24 MiB (larger than the change
         under test), which is exactly why RSS does not enter assertions. One methodological
         note: the `if (!flag)` → `if (false)` mutation survived; investigation showed it is
         an **equivalent mutation** (the other branch already detaches first), not a
         false-green assertion — it only turned red after swapping in mutations on two real
         paths
Cost     Falling back to log text, line numbers, or `hasOwnProperty` for criteria will all
         go blind together the next time line numbers drift; removing the mutation bench
         means "green but blind" can only be found by hand again
Commit   4c8c7f5

### D-013 · 2026-10-09 · chore · v8
Symptom  The three upstream-defect fallbacks live in the same `extension.js` (446 lines) as
         the grouping logic, so "delete wholesale once upstream fixes it" has no unit to
         delete; `NotificationMessage.prototype.close` is merely inherited from
         `Message.close`, and the degradation coupling that makes all three live and die
         together has no registry either
Change   Extracted `uiWorkarounds.js`: `attach()` detaches first itself (toggling back and
         forth does not stack layers), checks liveness after await, and its header spells out
         the 9 files to touch together when deleting; `repo.test.mjs` gained two guards,
         "fallbacks must not crawl back into extension.js" and "a patch point must live in
         the module that owns it"
Evidence L1 assertions unchanged word for word and still all green (this is the proof that
         "behavior is unchanged"); L0 guards exist and can go red; L2 unverified
Cost     Splitting it back only returns to "three comments in one file" and changes no
         behavior — hence recorded as chore rather than guard
Commit   96ce1a0

### D-014 · 2026-10-09 · revert · v8
Symptom  D-001 / D-002 deleted prefs and the rule engine, at the cost that users cannot turn
         grouping off, cannot tighten the per-group count, and cannot keep an app in its own
         stack — and these three are exactly what this round wanted (collapse behavior,
         per-group cap, per-app exceptions)
Change   Added a 4-key schema (`grouping-enabled` / `max-per-source` 1..10 / `ui-guards` /
         `isolate-apps`) + an Adw settings page + hot application; all four `changed::` ids
         are registered and disconnected one by one in `disable()`. **Only the "no
         preferences surface at all" rule is overturned**: no rules files restored, no
         title/urgency matching restored (the matching capability D-002 deleted stays
         deleted), and D-003's four items (third patch point, clear-group button, TTL,
         group-header title override) stay deleted. Default values equal the extension's
         original behavior, and zero-config still works out of the box; the cap uses native
         `MAX_NOTIFICATIONS_PER_SOURCE` as its upper bound and only allows tightening
Evidence L1 settings phase all green, and every key has a mutation counterpart (cap /
         grouping / isolate / ui-guards / disconnect each turns one corresponding assertion
         red); L0 `npm run check:prefs` introspection gate passes (libadwaita 1.9.1:
         `EntryRow` has no `subtitle`, `SpinRow` has no `value-changed`, an int key cannot
         bind to a double `value`). **L2 unverified: the dialog's actual rendering and
         interaction is M**
Cost     Restoring "zero settings" means overturning this round's decision; once released,
         schema keys are public API, so neither their names nor their types may change;
         `.xml` and `.compiled` must be committed in the same commit (GNOME 50 no longer
         compiles schemas for extensions)
Commit   96ce1a0

### D-015 · 2026-10-09 · fix · v8
Symptom  A comment in `groupEngine.js` said "never drops a message", directly contradicting
         native's per-source 10 with **synchronous destruction of the oldest**
         (`messageTray.js:25`, `:577-580`) — merging turns "one source" from one process into
         one app, amplifying the scope of this cap; the doc's `12/12`, `14/14`, and
         "`npm test` 11 cases" were hand-copied and have already drifted; the README's
         "disabling does not cancel already-merged groups" became false after D-011; the
         defect chain attributed the throw to "`.catch()` at `:341`", but that line is
         actually `this._updateText()`
Change   Rewrote the cap semantics truthfully (lower it only; do not stop native from
         dropping cards); changed native line numbers uniformly to ranges (`:1107-1112`,
         `:1114-1119`, `.catch()` is at `:1006` and belongs to the `ease_property_async`
         statement **after** the loop, so structurally it cannot catch the throw at `:992`);
         deleted all hand-copied aggregate numbers, letting the command that produces them
         print them instead; the bilingual README gained two sections, "Settings" and
         "Troubleshooting", and the disable semantics were fixed; the fixture dropped real
         app names and was renamed
Evidence All native anchors were re-read line by line on 2026-10-09 with
         `gresource extract /usr/lib/gnome-shell/libshell-18.so`; the bilingual README's
         section counts are compared by an L0 guard; L0 all green. The document body itself
         is in the same doc commit as this record
Cost     Keeping hand-copied numbers is the documentation version of "green but blind";
         misattributing `.catch()` will lead the next person to patch a promise that can
         never receive the exception
Commit   96ce1a0, 4c8c7f5

### D-016 · 2026-10-10 · fix · v9
Symptom  Setting `max-per-source` to 1 produced `Gjs-CRITICAL: Object
         Gjs_ui_notificationDaemon_FdoNotificationDaemonSource … has been already
         disposed`, with the stack `notificationDaemon.js:266 → :367 → messageTray.js:592`,
         and the frame where we wrap `NotifyAsync` is right beneath it. The root cause is
         the eviction timing: native **self-destroys** when a source's last notification is
         destroyed (`messageTray.js:569-570`
         `if (!this._inDestruction && this.notifications.length === 0) this.destroy()`),
         while we evict to cap-1 before the native push — cap=1 means empty. At cap>=2
         eviction still leaves at least one, so the default 10 and most values on the
         settings page show no symptom; only the endpoint 1 hits it
Change   Moved eviction to **after** the native push: `_getSourceForPidAndName` no longer
         evicts, it only registers the taken-over source into `_pending.servedSource`; the
         `NotifyAsync` wrapper evicts to cap after `_orig.notify.call` returns (that path is
         synchronous; the notification has entered the source by then). The visible count is
         still exactly the cap, and keep is always >= 1, so neither call site (after push,
         and when the setting is lowered) can empty the source
Evidence L1 all green (assertion counts are printed by the harness itself, not copied into
         this file), `already disposed` count 0 in the log; added endpoint and reason
         assertions (cap=1 leaves one card and still one source, cap=10 matches the native
         upper bound, the evicted card's reason is EXPIRED(1) not DISMISSED(2));
         `npm run verify:provoke` had every mutation turn red at the time, including the
         newly added post-push-trim-removed. Process note: the first round of fixing was
         only half done (it added post-push eviction but did not remove the pre-push
         eviction, and `servedSource` was never assigned), and it was the newly added
         mutation failing to go red that exposed it — an assertion against an idle code path
         is of course always green. L2 unverified (the current session still has the pre-fix
         code loaded)
Cost     Reverting to pre-push eviction makes it recur only at cap=1, and it only logs when
         the 11th eviction is really triggered — a classic "invisible at the default value"
         defect; the probe side also dropped the practice of reading an already-disposed
         wrapper after the fact — that critical was caused by the instrumentation itself, and
         it was once taken as a reading of a product defect
Commit   b09e179

### D-017 · 2026-10-10 · guard · v9
Symptom  D-016 recorded "the evicted card's reason is EXPIRED(1)", but that assertion read
         the destroy reason **inside the shell process**. What the sender receives is FDO's
         `NotificationClosed` broadcast, and the bus does not deliver a broadcast signal back
         to the sender — subscribing inside the shell process is always empty, so "what we
         actually told the sender" previously had no gate at all: if that mapping in
         `notificationDaemon.js:178-195` were wrong, L1 would still be all green. On the live
         side there were two instrumentation defects: `tests/smoke.sh` judged defects by the
         generic string `already disposed`, but in a real session a single boot produced 5
         hits, all of them noise from `St.Adjustment` / `Gjs_ui_layout_UiActor` in the second
         the shell restyles — **this criterion will falsely accuse**; and it lacked a more
         basic premise — whether this round's journal actually has an enable line (if JS was
         changed without logging back in, the extension is still ACTIVE, so missing this line
         amounts to ticking new code on top of old code)
Change   The harness starts `dbus-monitor` (`member=NotificationClosed`) on its own private
         session bus, listening from before the eviction phase, and asserts "at least 1
         captured and all reasons are 1"; the FAIL text prints the count so that "instrument
         not connected (0)" and "product reported a different reason" are distinguishable at
         a glance; the monitor output is included in stale-file cleanup. Mutation bench entry
         8, `evict-reason-dismissed`, swaps the EXPIRED used for eviction to DISMISSED and
         requires this new assertion to go red; the script header comment was rewritten to
         match the real coverage (it guards more than the four settings keys — it also guards
         eviction timing and reason). smoke.sh: the disposed criterion was narrowed to the
         class name `notificationDaemon_FdoNotificationDaemonSource`, other classes only
         report a count without entering the verdict; added "does this round have an enable
         line"; added the `max-per-source=1` live item and "why the remaining few must be
         seen by your own eyes". Also fixed the hand-copied `L1 40/40` in D-016 — this file's
         header states that aggregate numbers are printed by the command that produces them,
         and it had already drifted one version
Evidence L1 all green (counts printed by the harness itself), `Gjs-CRITICAL` 0 in the log;
         `npm run verify:provoke` had every mutation turn red at the time, including this new
         one; `verify:ui-guard` gives **opposite** conclusions in the two directions. New L2
         fact: the real session's gnome-shell started at 11:19 and `extension.js` was written
         to disk at 08:13, so the live session is indeed running the fixed code (the criterion
         is `ps -o lstart` compared against the file mtime, **not** `gnome-extensions info` —
         that reads on-disk metadata and does not reflect the loaded class); after setting the
         cap to 1, the journal's `FdoNotificationDaemonSource … already disposed` count is 0.
         This did not lead to declaring end-to-end true in the live session: the same live
         capture caught 3 `NotificationClosed` all with reason 1, but an ordinary timeout
         notification **naturally expiring reads exactly the same**, so it cannot be
         attributed to eviction — reason attribution is proven only by L1
         (`urgency=critical`, does not expire naturally, the only source is eviction)
Cost     The monitor lives only on this private bus, and the process ends with the harness;
         from now on, if you see 0, first suspect that `dbus-monitor` is not on PATH or the
         bus did not come up, rather than judging the product red. Leaving the generic
         disposed string in the criterion is leaving the next person to hunt for a
         nonexistent defect in the restyle noise
Commit   59ec0aa

### D-018 · 2026-10-10 · fix · v9
Symptom  The package produced by the release path is incomplete, and **incomplete with no
         sign at all**. GNOME 50's `gnome-extensions pack` only auto-collects fixed filenames
         (`metadata.json` / `extension.js` / `prefs.js` / `stylesheet*.css`), so the split-out
         engine module and fallback module are **silently dropped, exit code still 0**: the
         extracted package can't even get past `import`, and the whole extension fails to
         load. On the schema side it only collects `schemas/<id>.gschema.xml`, while at
         runtime `Gio.SettingsSchemaSource.new_from_directory()` opens
         `schemas/gschemas.compiled` (with only the .xml present it throws
         "Failed to open file …/gschemas.compiled" directly);
         `--extra-source=schemas/gschemas.compiled` puts that file in the zip **root
         directory** (wrong path equals not included), and `--schema=schemas` reports
         "Can't recursively copy directory" and likewise exits 0. All three verification
         layers being green still doesn't reveal this, because they all run against the
         source tree and no layer ever touches the artifact.
         Two boundaries must be honestly separated: what actually makes the extension fail
         to load is **the module being dropped**; a missing compiled schema is not
         necessarily fatal — a directory-installed extension has it generated in place by
         the installer (all four third-party packages on this machine have a
         `gschemas.compiled` mtime later than the same-named .xml), and the reason to add it
         to the zip is that **the artifact must equal the source tree** (a `git clone`
         install is exactly the source tree), not that "missing it is fatal"
Change   Release now uniformly goes through `npm run pack`: let the packer do the part it
         does, then add the compiled schema in with the correct arcname, and finally validate
         the zip contents against the **declared required manifest**, rejecting dev-time file
         leakage and exiting 1 when non-compliant. There is only one manifest, and an L0
         guard cross-checks it against the shipped JS's local imports — forgetting to
         register a new module goes red immediately (CI can run this layer; the runner has no
         `gnome-extensions`). The artifact itself goes through another round of L1: after
         unpacking, hand the directory to `tests/headless-verify.sh`
Evidence Red→green was actually tested: naive package **2/41**, completed package **41/41**
         (same harness, only the passed-in directory changed); the L0 guard's two FAIL
         branches were each forced red individually (omitting a module, omitting the compiled
         schema), with the other cases still green, showing that it is this one that goes red
         rather than the whole suite; the guard has its own anti-idle assertion (errors if
         local imports are fewer than 2). L0 all green, `check:log` green.
         **Impact scope verified**: the repo has no GitHub release and no tag, and the
         README's install method is `git clone` of the source tree, so no user ever received
         an incomplete package — what is broken is a release path not yet taken.
         Supplementary test: `gnome-extensions install <zip>` on this machine reports
         "Can't recursively copy directory" for **any** zip, exits 0, and installs nothing (a
         flat two-file package is the same), so it cannot serve as a release-verification
         instrument; the artifact can only be verified by unpacking and passing L1. This
         entry's first draft wrote the missing compiled schema as "users will break", which
         overstated it, and it was reverted per the boundary above; the correction and the
         conclusion are both visible in one follow-up commit
Cost     The consequence of leaving it is "the first zip upload ships an extension that
         fails to load", and the packer's exit 0 makes people think it succeeded; the artifact
         was moved to gitignore (regenerable, and must go through the gate again rather than
         trusting a cache), at the cost of running two extra commands before release
Commit   6041f3c
