// groupEngine.js — the notification-grouper pure functions (zero-config; groups only by the sending app).
//
// Constraints:
// - No gi / no Shell dependency; GJS (ESM) and Node share the same file.
// - Zero regex, zero file IO and zero timers on the hot path; only string normalisation and hash lookups.
// - The engine has no branch on any concrete app name: a generic name (notify-send / node-notifier) is
//   not a special case, it is just the identity the sender declares, and it is used as the grouping key
//   like any other.
//
// Grouping-key priority: desktopEntry > appId > normalised app_name.
// Group by whatever the sender declares: the same name merges across pids into one shared Source.
// The three mergeable=false cases all fall back to native per-pid isolation: app_name normalises to
// empty (the sender declares no identity), grouping-enabled=false, or a hit in the isolate-apps
// exception list.
//
// Per-source cap: MAX_NOTIFICATIONS_PER_SOURCE = 10 in native messageTray.js:25 **drops** the oldest
// entry (:577-580, a synchronous while loop, reason=EXPIRED). Merging turns "one source" from "one
// process" into "one app", so that cap's scope is widened — once the same app sends an 11th
// notification, the earliest one is gone. This extension drops nothing extra, but it does not stop
// native from dropping either; the max-per-source setting can only lower 10 (raising it would mean
// copying native addNotification, one more fragile patch point, not worth it).

/**
 * Normalise an app identity: trim, lower-case, strip the .desktop suffix.
 * No regex (hot-path rule); .desktop is a fixed-length suffix, so slice it directly.
 * @param {string} s
 * @returns {string}
 */
export function normalizeName(s) {
    const t = String(s ?? '').trim().toLowerCase();
    return t.endsWith('.desktop') ? t.slice(0, -'.desktop'.length) : t;
}

/**
 * Compute the grouping.
 * @param {object} [input]
 * @param {string} [input.appName]      the first argument of FDO Notify
 * @param {string} [input.desktopEntry] hints['desktop-entry'] (after unpacking)
 * @param {string} [input.appId]        reserved: the app id on the portal/Gtk path (usually absent on the FDO path)
 * @param {boolean} [input.enabled]     the grouping-enabled setting; false always falls through to native
 * @param {Set<string>|null} [input.isolated] the set of already-normalised exception app names (see normalizeIsolate)
 * @returns {{groupKey: string|null, mergeable: boolean}}
 *   When mergeable=true the groupKey looks like `app:<normalised identity>` and can reuse one shared Source;
 *   when mergeable=false the groupKey is null and the extension layer falls back to native per-pid isolation.
 *   Exception apps and disabled grouping both land on mergeable=false: the meaning is the same ("do not merge
 *   this one"), one native fallthrough path is enough, and no extra branch is added in the extension layer.
 */
export function computeGroup({ appName, desktopEntry, appId, enabled = true, isolated = null } = {}) {
    if (!enabled)
        return { groupKey: null, mergeable: false };

    const entry = normalizeName(desktopEntry);
    if (entry)
        return _group(entry, isolated);

    const id = normalizeName(appId);
    if (id)
        return _group(id, isolated);

    const name = normalizeName(appName);
    if (name)
        return _group(name, isolated);

    return { groupKey: null, mergeable: false };
}

function _group(identity, isolated) {
    if (isolated && isolated.has(identity))
        return { groupKey: null, mergeable: false };
    return { groupKey: `app:${identity}`, mergeable: true };
}

/**
 * Normalise the user's exception list into a lookup set (the settings store the raw strings and the
 * comparison happens on the hot path, so normalisation is done once, on read). Empty entries are
 * dropped, duplicates collapse, and case / surrounding spaces / .desktop do not matter.
 * @param {string[]} list
 * @returns {Set<string>}
 */
export function normalizeIsolate(list) {
    const out = new Set();
    for (const raw of list ?? []) {
        const n = normalizeName(raw);
        if (n)
            out.add(n);
    }
    return out;
}

// The patch points that must be attached (either missing -> the extension self-degrades to completely inert, logging one warning).
export const REQUIRED_PATCHES = [
    'NotifyAsync',
    '_getSourceForPidAndName',
];

// UI workaround points: they fix defects in GNOME's native messageList.js and are unrelated to the
// grouping mechanism, so they are independent of REQUIRED_PATCHES — failing to reach them costs only
// the workarounds and never drags grouping down.
export const REQUIRED_UI_GUARDS = [
    'Message.unexpand',
    'NotificationMessageGroup.collapse',
    'NotificationMessage.close',
];

/**
 * Self-check of the UI workaround points (a pure function, shared by _attachUiGuards self-degradation
 * and the unit tests).
 * @param {object} [info]
 * @param {boolean} [info.moduleLoaded] whether messageList.js imported successfully
 * @param {boolean} [info.hasMessage]
 * @param {boolean} [info.hasGroup]
 * @param {boolean} [info.hasNotifMessage]
 * @param {boolean} [info.hasUnexpand]
 * @param {boolean} [info.hasCollapse]
 * @param {boolean} [info.hasNotifClose]
 * @param {string} [info.detail] for diagnostics
 * @returns {{apply: boolean, warnings: string[], guards: string[]}}
 */
export function checkUiGuardPoints(info = {}) {
    const warnings = [];
    if (!info.moduleLoaded) {
        warnings.push(`messageList module unavailable [${info.detail ?? 'unknown'}]`);
    } else {
        if (!info.hasMessage)
            warnings.push('Message class not exported');
        if (!info.hasGroup)
            warnings.push('NotificationMessageGroup class not exported');
        if (!info.hasNotifMessage)
            warnings.push('NotificationMessage class not exported');
        if (!info.hasUnexpand)
            warnings.push('Message.prototype.unexpand missing');
        if (!info.hasCollapse)
            warnings.push('NotificationMessageGroup.prototype.collapse missing');
        if (!info.hasNotifClose)
            warnings.push('NotificationMessage.prototype.close missing');
    }
    if (warnings.length > 0)
        return { apply: false, warnings, guards: [] };
    return { apply: true, warnings, guards: [...REQUIRED_UI_GUARDS] };
}

/**
 * Self-check of the attach points (a pure function, shared by the extension's enable self-degradation
 * and the unit tests).
 * @param {object} [info]
 * @param {boolean} [info.hasFdo]
 * @param {string} [info.fdoKeys] for diagnostics: the property names actually seen
 * @param {boolean} [info.hasNotifyAsync]
 * @param {boolean} [info.hasGetSource]
 * @returns {{attach: boolean, warnings: string[], patches: string[]}}
 */
export function checkAttachPoints(info = {}) {
    const warnings = [];
    if (!info.hasFdo) {
        warnings.push(
            `_fdoNotificationDaemon unreachable [${info.fdoKeys ?? 'unknown'}]`);
    } else {
        if (!info.hasNotifyAsync)
            warnings.push('NotifyAsync missing on FDO instance');
        if (!info.hasGetSource)
            warnings.push('_getSourceForPidAndName missing on FDO instance');
    }
    if (warnings.length > 0)
        return { attach: false, warnings, patches: [] };
    return { attach: true, warnings, patches: [...REQUIRED_PATCHES] };
}
