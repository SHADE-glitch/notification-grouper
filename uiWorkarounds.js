// uiWorkarounds.js — temporary workarounds for GNOME 50's native messageList defects (three prototype patches).
//
// Role: this is not a grouping feature but cleanup for an upstream defect, so it must be a
// **deletable unit**. Once upstream fixes it, delete it following the checklist below (measured to
// touch 9 files; "just rm one file" is false):
//   1. rm uiWorkarounds.js
//   2. rm tests/headless-ui-guard.sh      — this provocation harness exists only for the workarounds
//   3. package.json                       — drop the verify:ui-guard script
//   4. extension.js                       — the header comment, the import, the detach() call in
//      disable(), the guards: part of the log line, and attach({...}) at the end of _attach()
//   5. groupEngine.js                     — REQUIRED_UI_GUARDS and checkUiGuardPoints
//   6. tests/test-groupEngine.mjs         — the 2 checkUiGuardPoints cases and their import
//   7. tests/repo.test.mjs                — HOME.guard, both REQUIRED_UI_GUARDS spots, and the
//      "workarounds must not leak into extension.js" assertion
//   8. tests/check-log.mjs                — remove 'uiWorkarounds.js' from CODE_PATHS
//   9. tests/headless-verify.sh           — the Uw import, guardsMountedBeforeJudging,
//      guardsRestoredToPristine, "disable log matches reality" and the matching python-side entries
// After deleting, record a revert in CHANGELOG citing the D-id that introduced the workarounds.
// They degrade independently of the grouping layer (extension.js) and the pure-function layer
// (groupEngine.js): failing to reach messageList.js costs only these three workarounds, never grouping.
//
// The state is module-level, not instance-level: prototype patches are process-global anyway, only one
// copy of the extension code ever exists in a shell, so module state and "is it currently mounted" are
// naturally isomorphic. A non-null _origUi is still the single "mounted" judge (the same pattern as the
// daemon layer's _orig).

import { checkUiGuardPoints, REQUIRED_UI_GUARDS } from './groupEngine.js';

let _ownsSource = null;
let _onError = null;
let _origUi = null;
let _applied = [];

/**
 * Mount the three workarounds. It must await (dynamic import), but the caller (the enable path)
 * **must not** await it: keeping enable() synchronous is part of the _pending hand-off assumption.
 *
 * @param {object} deps
 * @param {(src: object) => boolean} deps.ownsSource whether that Source was created by this extension
 *        (pass a predicate, not a Set: if enable() rebuilds the Set, a workaround holding the old Set
 *        silently stops working)
 * @param {(msg: string) => void} deps.log the log sink (keeping "one line per event, never the body")
 * @param {(e: any, msg: string) => void} deps.onError the stack sink when a native defect fires
 * @param {() => boolean} deps.alive whether the extension is still enabled (must be re-checked after the await)
 * @returns {Promise<string[]>} the workaround names actually mounted
 */
export async function attach({ ownsSource, log, onError, alive }) {
    detach();                      // idempotent: strip any leftover layer from a previous round first

    let mod = null;
    let detail = '';
    try {
        // Dynamic import: if upstream renames or deletes the file, a static import would put the whole
        // extension into an ERROR state where even grouping stops working, which is far worse than
        // "no workarounds".
        mod = await import('resource:///org/gnome/shell/ui/messageList.js');
    } catch (e) {
        detail = e && e.message ? e.message : String(e);
    }

    // We may have been disabled during the dynamic import: mounting then would leave nobody to restore it.
    if (!alive())
        return [];

    // detach must run *after* the await and before capturing. Placing it before the await is the same
    // as not placing it: two enable() calls resume this section in the same microtask round, and the
    // later one stores the earlier one's wrapper as the "native method", so the prototype stacks layers
    // and disable() can only strip the outermost one — the remaining layer lives forever and even makes
    // the disable log report the false result "restored three workarounds".
    detach();

    const Message = mod ? mod.Message ?? null : null;
    const Group = mod ? mod.NotificationMessageGroup ?? null : null;
    const NotificationMessage = mod ? mod.NotificationMessage ?? null : null;
    const check = checkUiGuardPoints({
        moduleLoaded: !!mod,
        detail,
        hasMessage: !!Message,
        hasGroup: !!Group,
        hasNotifMessage: !!NotificationMessage,
        hasUnexpand: !!(Message && typeof Message.prototype.unexpand === 'function'),
        hasCollapse: !!(Group && typeof Group.prototype.collapse === 'function'),
        hasNotifClose: !!(NotificationMessage &&
            typeof NotificationMessage.prototype.close === 'function'),
    });
    if (!check.apply) {
        _applied = [];
        log(`UI guards degraded: ${check.warnings.join('; ')}`);
        return _applied;
    }

    _ownsSource = ownsSource;
    _onError = onError;
    _origUi = {
        Message,
        Group,
        NotificationMessage,
        unexpand: Message.prototype.unexpand,
        collapse: Group.prototype.collapse,
        notifClose: NotificationMessage.prototype.close,
    };

    // Workaround 1 — Message.unexpand(animate) (messageList.js:644):
    // once an actor is detached from its container it has no layout manager, and native :646's
    // ease_property('@layout.expansion') needs one; without it the call throws synchronously
    // (_easeAnimatableProperty at environment.js:196 is a plain function, so .catch() cannot see it).
    // With no layout manager, land the final state directly and return, so collapse()'s forEach can
    // finish the remaining messages — otherwise one dirty message leaves every message after it stuck
    // expanded. For a healthy actor, forward untouched and never second-guess native.
    const origUnexpand = _origUi.unexpand;
    Message.prototype.unexpand = function (animate) {
        let hasLayout = false;
        try {
            hasLayout = !!this._bodyBin && this._bodyBin.get_layout_manager() !== null;
        } catch {
            hasLayout = false;
        }
        if (!hasLayout) {
            try {
                this._actionBin?.hide();
                this.expanded = false;
            } catch {
                /* actor already disposed */
            }
            return;
        }
        return origUnexpand.call(this, animate);
    };

    // Workaround 2 — NotificationMessageGroup.collapse() (messageList.js:988, async):
    // if forEach at :992 throws, :998's _expanded=false and :1000's _cover.show() never run, so the
    // group stays half-collapsed forever and every later click is swallowed by native :1114-1119's
    // if (!this.expanded) — what the user sees as "the notification area is stuck, clicks do nothing".
    // Here we catch the throw and land the state, without changing semantics.
    const origCollapse = _origUi.collapse;
    Group.prototype.collapse = async function () {
        try {
            return await origCollapse.call(this);
        } catch (e) {
            _onError(e, 'NotificationMessageGroup.collapse() threw');
            try {
                this._expanded = false;
                this.notify('expanded');
                this._cover?.show();
            } catch {
                /* group already disposed */
            }
        }
    };

    // Workaround 3 — NotificationMessage.close(): clicking one card's × in a collapsed group makes
    // native messageList.js:1107-1112 call signal_stop_emission and then group.close(), escalating
    // "close one card" into "close the whole group". A native source holds roughly one card, so the
    // cost is invisible; merging turns a group into N cards, so the cost is amplified. Only for a
    // **source this extension created** and a collapsed group do we close just this one card: run the
    // close signal's default handler on_close() directly (GJS auto-wires on_<signal>, verified),
    // skipping the emission so the group handler cannot escalate this close into closing the whole
    // group. Native sources, expanded groups and one-card groups always take the native path (a
    // one-card group reads as expanded per the getter at :952). If the judgement fails, fall back to
    // native and never swallow a close.
    const origNotifClose = _origUi.notifClose;
    NotificationMessage.prototype.close = function () {
        try {
            const item = this.get_parent();
            const group = item ? item.get_parent() : null;
            if (group instanceof Group && !group.expanded &&
                _ownsSource(group.source) &&
                typeof this.on_close === 'function') {
                this.on_close();
                return;
            }
        } catch {
            /* judgement failed: fall back to native */
        }
        return origNotifClose.call(this);
    };

    _applied = check.guards;
    return _applied;
}

/**
 * Restore the three workarounds. Safe to call repeatedly; a non-null _origUi is the single
 * "currently mounted" judge.
 * @returns {string[]} the workaround names actually restored this time (an empty array when never mounted)
 */
export function detach() {
    const o = _origUi;
    if (!o)
        return [];
    try {
        o.Message.prototype.unexpand = o.unexpand;
    } catch {
        /* best effort */
    }
    try {
        o.Group.prototype.collapse = o.collapse;
    } catch {
        /* best effort */
    }
    try {
        o.NotificationMessage.prototype.close = o.notifClose;
    } catch {
        /* best effort */
    }
    _origUi = null;
    _ownsSource = null;
    _applied = [];
    return [...REQUIRED_UI_GUARDS];
}

/** the currently mounted workaround names (non-empty after attach completes; empty after detach/degradation). */
export function applied() {
    return [..._applied];
}
