// notification-grouper@local — generic notification grouping for GNOME 50 (zero-config; groups only by the sending app).
//
// Mechanism: wrap two methods on the FDO instance plus one behaviour override that applies
// only to self-created sources (self-degradation: if either of the first two is missing the
// extension stays completely inert rather than half-mounted; the other two degrade independently):
//  1. The NotifyAsync wrapper: the entry point reads hints (deepUnpack), computeGroup() (a pure
//     function, see groupEngine.js) yields {groupKey, mergeable}, and the result is stashed in
//     _pending (carrying two consistency-check fields: senderPid and the raw app_name). Source
//     check against 50.1: NotifyAsync is a synchronous method (notificationDaemon.js) with no
//     await between the entry point and the source lookup, and the whole file has no async — so
//     the try/finally stash is safe (JS is single-threaded and D-Bus dispatch is synchronous,
//     so there is no re-entry).
//  2. The _getSourceForPidAndName wrapper: consumes _pending. When mergeable it reuses or creates
//     a shared Source by groupKey; when mergeable=false (empty app_name) it always falls through
//     to native. Sources already resolved to source.app go through _getSourceForApp, where native
//     already stacks by App and this extension stays out; the Gtk path (GtkNotificationDaemon*)
//     is a separate object and class, not referenced and not patched.
//  3. When creating a shared Source, override its open(): native open() calls
//     destroyNonResidentNotifications(), which empties the whole source — a native source holds
//     roughly one card, but a merged source holds a whole group, so clicking one card wipes the
//     group. The override keeps only openApp() (a no-op here since this source's app is always
//     null), and the clicked card is still destroyed by Notification.activate() itself. Native
//     sources are never touched and are restored on disable.
//
// Coverage: every source that resolves to no App (the _getSourceForPidAndName path) — sources
// that have an app_name but no App. Native creates a new Source for every new pid; this extension
// merges them into one shared Source by normalised app_name, which is what "group by the sending
// app" means.
//
// UI, icons and the cap all stay native: _appName/_appIcon are not overridden and no button is
// injected. The only UI behaviour differences are item 3 above (a self-created source's open() no
// longer mass-clears) and the close workaround below, both of which act only on the merged sources
// this extension creates. On disable we restore the two daemon patches, the self-created sources'
// open() overrides and the three UI workarounds, disconnect every per-source signal, and
// **destroy the merged sources this extension created** (the watch_name and policy they hold are
// released only in destroy(), and leaving them alive would let the restored native open()
// mass-clear the whole group again) — so disabling undoes every piece of state this extension
// produced.
//
// Logging: quiet by default — one line each for enable/attach/disable; no per-notify logging and
// never the body.
//
// The UI workarounds live in uiWorkarounds.js: GNOME 50's native messageList.js has three
// behaviours that trap an N-card merged group (a collapse race ×2, and closing one card escalating
// to closing the whole group). Failing to reach messageList.js costs only the workarounds, never
// grouping; once upstream fixes them that file is deleted as a unit — which is why it is its own
// module rather than three comment blocks here.

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { NotificationDestroyedReason } from 'resource:///org/gnome/shell/ui/messageTray.js';

import { computeGroup, checkAttachPoints, normalizeIsolate } from './groupEngine.js';
import * as UiWorkarounds from './uiWorkarounds.js';

// Native per-source cap. The upper bound of max-per-source in the schema must equal it —
// going past 10 would mean copying native addNotification (destroy the old entry + two
// connects + push + countUpdated), which adds one more fragile patch point.
const NATIVE_MAX_PER_SOURCE = 10;

const LOG_PREFIX = '[notification-grouper]';

export default class NotificationGrouperExtension extends Extension {
    _enabled = false;
    /** groupKey -> {source, hid, origOpen, patchedOpen} (shared-Source cache; self-clears on destroy) */
    _shared = new Map();
    /** the set of merged Sources this extension created: the UI workarounds use it to tell "this card belongs to this extension" */
    _ownSources = new Set();
    /** the computeGroup result and check context of the current synchronous call (see design item 1 in the file header) */
    _pending = null;
    _orig = null;
    _appliedPatches = [];
    _warned = new Set();
    /** settings cache: the hot path reads memory only and never calls get_* per notification (refreshed on changed::) */
    _settings = null;
    /** handler ids for changed::; disable() must disconnect each one */
    _settingsHids = [];
    _groupingEnabled = true;
    _uiGuardsEnabled = true;
    _maxPerSource = NATIVE_MAX_PER_SOURCE;
    _isolated = new Set();

    enable() {
        this._enabled = true;
        // Reset only pure bookkeeping fields. **Never** rebuild _shared / _ownSources here:
        // they record the patches mounted onto other people's objects in the previous round
        // (self-created sources' open() overrides and per-source destroy connections).
        // Rebuilding them orphans those patches, so disable() has nothing to restore — the
        // patches would outlive disable, and the close workaround would silently fail because
        // _ownSources lost its entries. Same invariant as _attach() calling _detachPatches()
        // first: enable() must be idempotent.
        this._pending = null;
        this._appliedPatches = [];
        this._warned = new Set();
        // Read settings before attaching: both the wrappers and the workaround mount depend on these cached values.
        this._loadSettings();
        // Main.notificationDaemon is created in main.js before ExtensionManager
        // (the notificationDaemon constructor synchronously builds _fdoNotificationDaemon),
        // so it is already ready at enable time and no async import is needed.
        try {
            this._attach();
        } catch (e) {
            logError(e, `${LOG_PREFIX} attach failed, staying inert`);
        }
    }

    disable() {
        this._enabled = false;
        this._detachPatches();
        const restoredGuards = UiWorkarounds.detach();
        this._teardownSettings();
        for (const [, rec] of this._shared) {
            try {
                rec.source.disconnect(rec.hid);
            } catch {
                /* already gone */
            }
            // Restore the open() override on the merged source (native sources were never overridden).
            try {
                if (rec.patchedOpen && rec.source.open === rec.patchedOpen)
                    rec.source.open = rec.origOpen;
            } catch {
                /* source already disposed */
            }
            // A source this extension created must not outlive disable(). It holds a
            // Gio.DBus.watch_name subscription and a NotificationPolicy, both released only in
            // Source.destroy() (messageTray.js:597-609: policy.destroy() + run_dispose()); more
            // importantly, once open() is restored to the native one, that method's second step
            // destroyNonResidentNotifications() acts again on a multi-card source, so "click one
            // card, wipe the group" comes back after disabling. If rec is still in the table
            // here, this source was never destroyed (a destroy self-clears the record through
            // rec.hid), so there is no double destroy.
            try {
                rec.source.destroy();
            } catch {
                /* source already disposed */
            }
        }
        this._shared.clear();
        this._ownSources.clear();
        this._pending = null;
        const restored = this._appliedPatches;
        this._appliedPatches = [];
        log(`${LOG_PREFIX} disabled, restored patches: ` +
            `${restored.length > 0 ? restored.join(', ') : '(none were applied)'}` +
            `, guards: ${restoredGuards.length > 0 ? restoredGuards.join(', ') : '(none)'}`);
    }

    /**
     * Restore the two patches. Safe to call repeatedly (already-restored is a no-op and never
     * reports "restored 0 patches"). _orig is set only when patches were really mounted, so its
     * presence is the single judge of "currently wrapped".
     */
    _detachPatches() {
        const o = this._orig;
        if (!o)
            return;
        try {
            if (o.fdo && o.notify)
                o.fdo.NotifyAsync = o.notify;
        } catch {
            /* best effort */
        }
        try {
            if (o.fdo && o.getSource)
                o.fdo._getSourceForPidAndName = o.getSource;
        } catch {
            /* best effort */
        }
        this._orig = null;
    }

    // ---- Settings ----
    //
    // The schema ships with the extension directory (schemas/ + the metadata settings-schema;
    // the shell-side implementation is extensions/sharedInternals.js:92, and since 50 GNOME no
    // longer compiles schemas automatically, so gschemas.compiled must land in the same commit as
    // the .xml). It has exactly two jobs: read once into memory (the hot path reads the cache per
    // notification and never does IO) and refresh on changed::. Every handler id goes into
    // _settingsHids and disable() disconnects each one — the same rule as patches: once
    // registered, there must be a path that undoes it.
    // Logging is one line per toggle (those are user actions, not notifications); dragging the
    // cap fires repeatedly, so it is deliberately not logged.

    _loadSettings() {
        const s = this.getSettings();
        this._settings = s;
        this._readSettings();
        this._settingsHids = [
            s.connect('changed::grouping-enabled', () => {
                this._groupingEnabled = s.get_boolean('grouping-enabled');
                log(`${LOG_PREFIX} grouping ${this._groupingEnabled ? 'on' : 'off'}`);
            }),
            s.connect('changed::ui-guards', () => {
                this._uiGuardsEnabled = s.get_boolean('ui-guards');
                log(`${LOG_PREFIX} UI guards ${this._uiGuardsEnabled ? 'on' : 'off'}`);
                this._mountUiGuards();
            }),
            s.connect('changed::max-per-source', () => {
                this._maxPerSource = s.get_int('max-per-source');
                // There is no "next" notification to make room for, so trim the existing stack to the cap itself (not cap-1)
                for (const [, rec] of this._shared)
                    this._evictTo(rec.source, this._maxPerSource);
            }),
            s.connect('changed::isolate-apps', () => this._readSettings()),
        ];
    }

    _readSettings() {
        const s = this._settings;
        this._groupingEnabled = s.get_boolean('grouping-enabled');
        this._uiGuardsEnabled = s.get_boolean('ui-guards');
        this._maxPerSource = s.get_int('max-per-source');
        this._isolated = normalizeIsolate(s.get_strv('isolate-apps'));
    }

    _teardownSettings() {
        const s = this._settings;
        if (!s)
            return;
        for (const id of this._settingsHids)
            s.disconnect(id);
        this._settingsHids = [];
        this._settings = null;
    }

    /**
     * Trim a stack to `keep` entries, mirroring the semantics of native messageTray.js:577-579
     * (destroy the oldest, reason=EXPIRED). There are only two call sites, and both must
     * guarantee **at least one entry remains after trimming**:
     *  1. In NotifyAsync, **after** the native push, keep = max-per-source (length is then cap+1,
     *     so the visible count is exactly cap);
     *  2. When the setting is lowered, immediately prune the existing stack, keep = the new cap.
     * keep=0 is forbidden: native sees the underlying list empty and calls `this.destroy()`
     * (messageTray.js:569-570), and that source is then pushed to again, stepping straight onto a
     * disposed object.
     * reason must be EXPIRED: the FDO side uses it to decide whether the app is sent
     * NotificationClosed(EXPIRED) or (DISMISSED) (notificationDaemon.js:178-195), so passing the
     * wrong one is like "manually closing" it on the user's behalf.
     * When cap == NATIVE_MAX_PER_SOURCE the loop condition equals native, so no special case is needed.
     */
    _evictTo(source, keep) {
        while (source.notifications.length > keep) {
            const [oldest] = source.notifications;
            oldest.destroy(NotificationDestroyedReason.EXPIRED);
        }
    }

    /**
     * Mount/unmount the three UI workarounds according to the toggle. attach() detaches first, so
     * flipping back and forth never stacks layers (the same invariant as enable()'s idempotence).
     * Not awaited: enable() must stay synchronous, consistent with the _pending hand-off assumption.
     */
    _mountUiGuards() {
        if (!this._uiGuardsEnabled) {
            UiWorkarounds.detach();
            return;
        }
        UiWorkarounds.attach({
            ownsSource: src => this._ownSources.has(src),
            log: m => log(`${LOG_PREFIX} ${m}`),
            onError: (e, m) => logError(e, `${LOG_PREFIX} ${m}`),
            // We may have been disabled during the dynamic import, or the user may have flipped the workaround toggle off: mounting then would leave nobody to restore it.
            alive: () => this._enabled && this._uiGuardsEnabled,
        }).then(guards => {
            if (guards.length > 0)
                log(`${LOG_PREFIX} UI guards attached: ${guards.join(', ')}`);
        }).catch(e => {
            logError(e, `${LOG_PREFIX} UI guards attach failed`);
        });
    }

    // ---- Attach to the FDO instance ----

    _attach() {
        const daemon = Main.notificationDaemon || null;
        const fdo = daemon ? daemon._fdoNotificationDaemon : null;
        const check = checkAttachPoints({
            hasFdo: !!fdo,
            fdoKeys: fdo
                ? Object.keys(fdo).join(',')
                : daemon
                    ? Object.keys(daemon).join(',')
                    : 'Main.notificationDaemon is null',
            hasNotifyAsync: !!(fdo && typeof fdo.NotifyAsync === 'function'),
            hasGetSource: !!(fdo && typeof fdo._getSourceForPidAndName === 'function'),
        });
        if (!check.attach) {
            this._appliedPatches = [];
            log(`${LOG_PREFIX} WARNING degraded, staying inert: ${check.warnings.join('; ')}`);
            return;
        }

        // Re-entry guard: when enable is called without a disable (_orig still points at the
        // previous round's wrapper), we must restore first and only then re-capture the original
        // methods. Otherwise the wrapper is stored as the "original", disable restores only as far
        // as the wrapper, and a wrapper referencing a dead instance lingers forever.
        this._detachPatches();

        this._orig = {
            fdo,
            notify: fdo.NotifyAsync,
            getSource: fdo._getSourceForPidAndName,
        };

        const self = this;

        fdo.NotifyAsync = function (params, invocation) {
            // FDO Notify argument slots: 0 app_name, 1 replaces_id, 2 app_icon,
            // 3 summary, 4 body, 5 actions, 6 hints, 7 timeout.
            // At the entry point the hints are still GLib.Variant, so they need deepUnpack.
            const hints = params[6] || {};
            const read = (k) => {
                try {
                    const v = hints[k];
                    return v ? v.deepUnpack() : null;
                } catch {
                    return null;
                }
            };
            const res = computeGroup({
                appName: params[0],
                desktopEntry: read('desktop-entry'),
                enabled: self._groupingEnabled,
                isolated: self._isolated,
            });
            // _pending is set for every call: when the Shell recognises replaces_id it takes the
            // reuse branch (never reaching _getSource, so the stash has no effect); when it does
            // not (stale id) it falls into the else branch and _getSource uses the stash to merge.
            // The stash carries two consistency-check fields, pid and the raw app_name — pid alone
            // can only catch cross-process misalignment, not one process interleaving sends under
            // different app_names (same pid, guard lets it through), which is the case that would
            // silently merge into the wrong group, so both are recorded.
            self._pending = {
                res,
                pid: read('x-shell-sender-pid'),
                appName: params[0],
            };
            try {
                return self._orig.notify.call(this, params, invocation);
            } finally {
                // The trim must happen **after** the push. Native destroys the whole source when
                // its last notification is destroyed (messageTray.js:569-570), so emptying it
                // before the push would leave the following native addNotification operating on a
                // disposed object — measured as a Gjs-CRITICAL "has been already disposed" with
                // our wrapper frame two frames down the stack (notificationDaemon.js:266 → :367 →
                // messageTray.js:592). NotifyAsync is synchronous, so on return the notification
                // is already in the source; trimming to cap here is exact and never empties the
                // source (cap >= 1, length = cap + 1).
                const served = self._pending && self._pending.servedSource;
                if (served)
                    self._evictTo(served, self._maxPerSource);
                self._pending = null;
            }
        };

        fdo._getSourceForPidAndName = function (sender, pid, appName) {
            const pend = self._pending;
            // No stash, or an empty app_name: fall through to native, isolated by pid.
            if (!pend || !pend.res.mergeable)
                return self._orig.getSource.call(this, sender, pid, appName);
            // Defensive: the stashed pid differs from this call's pid -> the synchronous
            // assumption was broken by a distro patch (NotifyAsync gained an await/re-entry).
            // Fall to the safe side: native fall-through + a one-line warning.
            if (pend.pid != null && pid != null && pend.pid !== pid) {
                self._warnOnce('pending-mismatch',
                    `pending mismatch: stashed pid=${pend.pid} vs call pid=${pid}, falling through to native (the synchronous assumption broke, please report)`);
                return self._orig.getSource.call(this, sender, pid, appName);
            }
            // Defensive: the stashed app_name differs from this call's -> the stash belongs to
            // another notification (the same sender process interleaved). The groupKey was then
            // computed from someone else's name, so we must fall through, or this notification
            // would be merged into another app's stack and change its title.
            if (pend.appName !== appName) {
                self._warnOnce('pending-appname-mismatch',
                    `pending mismatch: stashed app_name=${JSON.stringify(pend.appName)} vs call ` +
                    `${JSON.stringify(appName)}, falling through to native (the synchronous assumption broke, please report)`);
                return self._orig.getSource.call(this, sender, pid, appName);
            }
            const key = pend.res.groupKey;
            const rec = self._shared.get(key);
            if (rec) {
                // Reuse the existing source. Do **not** trim here: trimming to cap-1 with cap=1
                // empties the source, and native sees the underlying list empty and calls
                // self.destroy() (messageTray.js:569-570), so the following addNotification steps
                // onto a disposed object. Only record "I took over this one"; the trim is left to
                // the NotifyAsync wrapper, after the push.
                pend.servedSource = rec.source;
                return rec.source;
            }
            const source = self._orig.getSource.call(this, sender, pid, appName);

            // Third mount point (independent of the grouping patches and degrading on its own): a
            // merged source has no app (native passes null on this path), so native
            // Source.open() = openApp() (a no-op for a null app, and it does not close the calendar
            // either) + destroyNonResidentNotifications(), the latter wiping every non-resident
            // notification in the **whole shared source**. A native source holds roughly one
            // sender, so usually only one card is wiped; merging widens the scope to the whole
            // group — the user sees "click one card -> blank area -> the whole group disappears".
            // Here we keep only the "open the app" half and drop the mass destroy; the clicked card
            // is still destroyed by Notification.activate()'s subsequent destroy(), so clicking any
            // card deletes only that card.
            let origOpen = null;
            let patchedOpen = null;
            const rawOpen = source.open;
            if (typeof rawOpen === 'function') {
                origOpen = rawOpen;
                patchedOpen = function () {
                    if (typeof this.openApp === 'function')
                        return this.openApp();
                };
                source.open = patchedOpen;
            } else {
                self._warnOnce('source-open-missing',
                    'FdoNotificationDaemonSource.open is unavailable, so clicking one card will still wipe the whole group (please report)');
            }

            self._ownSources.add(source);
            // Self-clearing on destroy: delete only if the cache still holds this source (so a
            // delayed destroy of an old source cannot delete a new source with the same key).
            const hid = source.connect('destroy', () => {
                const cur = self._shared.get(key);
                if (cur && cur.source === source) {
                    self._shared.delete(key);
                    self._ownSources.delete(source);
                }
            });
            self._shared.set(key, { source, hid, origOpen, patchedOpen });
            // Same for a newly created source: the trim is not done here; after recording, it is left to the post-push block.
            pend.servedSource = source;
            return source;
        };

        this._appliedPatches = check.patches;
        log(`${LOG_PREFIX} enabled, attached patches: ${this._appliedPatches.join(', ')}`);

        // Only discuss the workarounds once grouping is mounted (they degrade independently but never exist alone on an inert instance).
        this._mountUiGuards();
    }

    _warnOnce(key, msg) {
        if (this._warned.has(key))
            return;
        this._warned.add(key);
        log(`${LOG_PREFIX} WARNING ${msg}`);
    }
}
