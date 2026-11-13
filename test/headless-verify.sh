#!/bin/bash
# test/headless-verify.sh — runtime verification of extension.js
#
# Why this file exists: `npm test` only covers groupEngine.js (pure functions).
# The two wrappers, the enable/disable contract and the _shared cache can only
# be executed by GJS inside a real shell. This script boots a throwaway headless
# GNOME Shell on a private D-Bus session and drives the extension there.
#
#   usage: test/headless-verify.sh [<extension-dir>]
#   exit:  0 all assertions passed, 1 something failed
#
# It is isolated by construction and must stay that way:
#   - dbus-run-session       -> private session bus, notifications never reach
#                               the user's live desktop
#   - GSETTINGS_BACKEND=memory -> every gsettings write is discarded; the real
#                               dconf database is never touched
#   - private XDG_DATA_HOME  -> only this extension exists there
#   - unique --wayland-display -> otherwise mutter fights the live compositor
#                               over wayland-0 and dies in a cascade that looks
#                               like a shell bug
#
# Traps already paid for, do not rediscover them:
#   - GNOME 50's scanner refuses symlinked extension dirs. Copy, never symlink.
#   - `gnome-shell --nested` was removed in 50; use --headless + --virtual-monitor.
#   - --unsafe-mode is what serves org.gnome.Shell.Eval; there is no dconf key
#     for it on 50.1 anymore. A shell without Eval still answers with exit 0, so
#     readiness must be tested by grepping for "(true," not by $?.
#   - Under the memory backend enabled-extensions is empty, so ExtensionManager
#     never loads the extension: loadExtension() returns nothing and lookup()
#     gives an ExtensionInfo with no state object. Constructing the instance
#     directly is the intended path here — the manager's loading machinery is
#     not what this test is about.
#   - ExtensionBase exposes uuid/dir/path as getters over the metadata object,
#     and initTranslations() needs dir to be a real Gio.File (GLib.File does
#     not exist in GJS).
#   - GLib.spawn_async returns [success, pid, ...] — the second element is a
#     number, not a Gio.Subprocess, so it has no wait_async().
#   - `gdbus call ... -1` fails: gdbus parses the bare -1 as an option. Use
#     notify-send instead of raw gdbus for sending.
#   - The forged metadata stub must carry 'settings-schema' (read from metadata.json,
#     never retyped). Without it getSettings() throws inside enable(), and every
#     assertion downstream reads "got None" — which looks like a broken settings layer
#     but is a missing part in the instrument.
#   - The probe JS sits in an UNQUOTED heredoc (it needs $STAGED/$RES), so inside it a
#     backtick is command substitution and ${x} is shell expansion: `s${i}` silently
#     became N(name, ), GLib rejected the argv ("Invalid element in string array") and
#     everything downstream read None. Write 'card' + i, never a template literal.
#   - Restore checks must compare IDENTITY against the function captured before
#     enable(), never `hasOwnProperty` and never a line number. Assigning an
#     inherited method back onto an instance/prototype creates an own property
#     that survives a correct restore, so hasOwnProperty is true either way; and
#     the old r'extension\.js:1\d\d' frame counter silently stopped matching once
#     the wrappers moved past line 199.
#   - WeakRef + imports.system.gc() is NOT usable as a leak probe here: measured on
#     this machine, a GObject wrapper stays alive after an explicit gc. Use
#     GObject.signal_handler_is_connected instead — it is exact and deterministic.
#   - The UI guards attach asynchronously, so any assertion about them needs an
#     await between enable() and the read, or it observes nothing at all.
set -u

EXT=${1:-$(CDIR=$(cd "$(dirname "$0")/.." && pwd) && echo "$CDIR")}
V=${TMPDIR:-/tmp}/ng-verify
UUID=notification-grouper@local
# settings-schema must be read from metadata.json: the probe builds the extension from forged
# metadata, so if the stub lacks this key getSettings() throws and the whole assertion chain reads
# "got None" — which looks like a broken settings surface but is really a missing part in the
# harness's own instrument.
SCHEMA=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('settings-schema',''))" "$EXT/metadata.json")
[ -n "$SCHEMA" ] || { echo "metadata.json has no settings-schema; nothing to verify" >&2; exit 1; }
LABEL=verify
STAGED="$V/xdg-$LABEL/gnome-shell/extensions/$UUID"
WD=wayland-$LABEL
RES="$V/res-$LABEL.json"

rm -rf "$V/xdg-$LABEL" "$RES" "$V/log-$LABEL.txt" "$V/dbusmon-$LABEL.txt"
mkdir -p "$V/xdg-$LABEL/gnome-shell/extensions"
cp -a "$EXT" "$STAGED"
rm -rf "$STAGED/.git"
md5sum "$STAGED/extension.js" | sed 's/^/staged /'

cat > "$V/probe-$LABEL.js" <<JSPROBE
(async () => {
    const out = {};
    const GLib = imports.gi.GLib;
    const Gio = imports.gi.Gio;
    const say = (k, v) => { out[k] = v; };
    const EXTDIR = '$STAGED';
    const MON = '$V/dbusmon-$LABEL.txt';
    try {
        const Main = await import('resource:///org/gnome/shell/ui/main.js');
        const ml = await import('resource:///org/gnome/shell/ui/messageList.js');
        const GObject = imports.gi.GObject;
        const mod = await import('file://' + EXTDIR + '/extension.js');
        const Uw = await import('file://' + EXTDIR + '/uiWorkarounds.js');
        const fdo = Main.notificationDaemon._fdoNotificationDaemon;
        const pNotify = fdo.NotifyAsync, pGet = fdo._getSourceForPidAndName;
        // Captured BEFORE any enable(): the only valid "was it restored" judge is
        // identity against these. Note NotificationMessage has no own close() in
        // native — this reads the one inherited from Message, which is exactly what
        // a correct restore must equal again.
        const pUnexpand = ml.Message.prototype.unexpand;
        const pCollapse = ml.NotificationMessageGroup.prototype.collapse;
        const pClose = ml.NotificationMessage.prototype.close;
        const rssKiB = () => {
            try {
                const raw = new TextDecoder().decode(
                    GLib.file_get_contents('/proc/self/statm')[1]).trim();
                return Math.round(Number(raw.split(' ')[1]) * 4);
            } catch { return -1; }
        };
        const rss = { baseline: rssKiB() };
        say('haveFdo', !!fdo);
        say('havePrototypes',
            [pUnexpand, pCollapse, pClose].every(f => typeof f === 'function'));

        const inst = new mod.default({
            uuid: '$UUID',
            name: 'Notification Grouper',
            'shell-version': ['50'],
            'settings-schema': '$SCHEMA',
            dir: Gio.File.new_for_path(EXTDIR),
            path: EXTDIR,
        });
        say('constructed', true);

        inst.enable();
        say('wrapperInstalled',
            fdo.NotifyAsync !== pNotify && fdo._getSourceForPidAndName !== pGet);

        // Invariant under test: _attach() must be idempotent. A second enable()
        // without a disable() used to capture the wrapper as the "original",
        // and the following re-enable then recursed into itself (~500 frames)
        // while dropping every notification.
        inst.enable();
        inst.enable();
        inst.disable();
        say('restoredPristine',
            fdo.NotifyAsync === pNotify && fdo._getSourceForPidAndName === pGet);

        inst.enable();
        say('reattached', fdo.NotifyAsync !== pNotify);

        const sleep = ms => new Promise(r => GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.Source.REMOVE; }));
        // fire-and-forget: each send is its own short-lived process => own pid
        const N = (appName, title) => {
            const [ok] = GLib.spawn_async(null,
                ['notify-send', '--urgency=critical', '--app-name=' + appName,
                 title, 'body'],
                null, GLib.SpawnFlags.SEARCH_PATH, null, null);
            if (!ok)
                out.spawnFailed = (out.spawnFailed || 1);
        };

        // three sends, three different pids, ONE declared name -> one source
        N('VerifyMerge', 'title-A'); await sleep(500);
        N('VerifyMerge', 'title-B'); await sleep(500);
        N('VerifyMerge', 'title-C'); await sleep(500);
        // different declared name -> its own source
        N('VerifyOther', 'title-D');
        await sleep(2500);
        rss.afterBurst = rssKiB();

        const srcs = Main.messageTray.getSources ? [...Main.messageTray.getSources()] : [];
        say('sourceCount', srcs.length);
        say('titles', srcs.map(s => s.title));
        say('notifCounts', srcs.map(s => (s.notifications ? s.notifications.length : -1)));
        say('sharedKeys', [...inst._shared.keys()]);
        // The app_name consistency guard must stay silent: native passes the
        // very same appName string from NotifyAsync to the source lookup, so a
        // non-empty value here means grouping has silently died.
        say('warnedKeys', [...inst._warned]);
        say('nativePidKeys', [...fdo._sourceForPidAndName.keys()]);
        say('nativeAppSources', fdo._sourcesForApp.size);

        // Regression: opening a card must not wipe the whole merged source.
        // Native FdoNotificationDaemonSource.open() runs
        // destroyNonResidentNotifications(), which empties the source; native
        // sources hold one card so it is invisible, but the merged source holds
        // the whole group (that is the "click one card -> blank tray, group
        // gone" report). The extension overrides open() on the sources it
        // creates, so only the clicked card's own activate() destroy survives.
        const merged = srcs.find(s => s.title === 'VerifyMerge');
        if (merged) {
            say('mergedIsOwned', inst._ownSources ? inst._ownSources.has(merged) : false);
            say('mergedNotifsBeforeOpen', merged.notifications.length);
            merged.open();
            say('mergedNotifsAfterOpen', merged.notifications.length);
        }

        // The other half of the same click: a merged source has no app, so native's
        // openApp() returns before its Main.panel.closeCalendar() and the list stays open
        // after a card with nowhere to jump is dismissed. The override closes the page only
        // when the click takes the stack's last card. The panel page cannot be observed in
        // a headless shell, so the promise under test is the call itself — judged twice,
        // once with cards left (must not fire) and once on the last card (must fire).
        if (merged) {
            const origCloseCalendar = Main.panel.closeCalendar;
            let closes = 0;
            Main.panel.closeCalendar = () => { closes++; };
            merged.open();
            say('openWithCardsLeftClosedPage', closes === 0);
            say('openWithCardsLeftCount', merged.notifications.length);
            merged.notifications.slice(1).forEach(n => n.destroy());
            say('mergedDownToOne', merged.notifications.length);
            merged.open();
            say('openOnLastCardClosedPage', closes === 1);
            Main.panel.closeCalendar = origCloseCalendar;
        }

        // ---- F1: a second enable() with NO disable() in between ----
        //
        // The daemon patches are idempotent (proved by 'restoredPristine' above), but
        // the other two layers keep per-object state: every merged source carries an
        // own open() override plus a 'destroy' handler, and the UI guards live on
        // native prototypes. enable() used to reset _shared / _ownSources / _origUi
        // before attaching, which orphans the source layer (nothing is left to restore
        // it) and lets the guard layer capture its own previous wrapper.
        const recBefore = inst._shared.get('app:verifymerge');
        const hidBefore = recBefore ? recBefore.hid : null;
        const protoOpen = merged ? Object.getPrototypeOf(merged).open : null;
        out.f1Setup = { recordFound: !!recBefore, handlerFound: hidBefore != null,
                        prototypeOpenFound: !!protoOpen };
        // Observe the restoration WHILE the source is still alive. Source.destroy()
        // emits 'destroy' before run_dispose() (messageTray.js:605-608), so a handler
        // attached here sees the end state of disable() — the extension's own signal
        // already disconnected, the instance open() already back to the prototype's.
        // Reading those two facts after disable() instead would touch a disposed wrapper
        // and log a Gjs-CRITICAL whose stack repeats our wrapper frame (the recursion
        // guard then reports it), which is exactly what an earlier draft of this probe did.
        const f1Observed = {};
        if (merged) {
            merged.connect('destroy', () => {
                f1Observed.openRestored = merged.open === protoOpen;
                try {
                    f1Observed.handlerGone =
                        GObject.signal_handler_is_connected(merged, hidBefore) === false;
                } catch {
                    f1Observed.handlerGone = false;
                }
            });
        }
        out.f1Observed = f1Observed;
        inst.enable();
        // _attachUiGuards() mounts asynchronously. Without this wait every guard
        // assertion below would observe a layer that was never mounted, i.e. a
        // passing test that proves nothing.
        await sleep(1500);
        rss.afterReenable = rssKiB();
        // Precondition, not a differentiator: without it the restoration assertions
        // below could pass simply because nothing was ever mounted.
        say('guardsMountedBeforeJudging', (() => {
            // The guard state moved into uiWorkarounds.js (module-level), so read it
            // from the module rather than from the extension instance.
            const g = Uw.applied();
            return Array.isArray(g) && g.length === 3;
        })());
        say('recordSurvivesReenable', (() => {
            const r = inst._shared.get('app:verifymerge');
            return !!r && !!merged && r.source === merged;
        })());
        say('ownSourceSurvivesReenable',
            !!merged && !!(inst._ownSources && inst._ownSources.has(merged)));

        inst.disable();
        say('finalRestored',
            fdo.NotifyAsync === pNotify && fdo._getSourceForPidAndName === pGet);
        // F6-B: the sources this extension created must not outlive disable().
        // They hold a Gio.DBus.watch_name subscription and a NotificationPolicy
        // (released only by Source.destroy()), and leaving them means the restored
        // native open() resumes destroyNonResidentNotifications() on a multi-card
        // source — i.e. "close one card, wipe the group" comes back after disable.
        say('sourceDestroyedByDisable', !!merged &&
            ![...Main.messageTray.getSources()].includes(merged));
        say('nativePidCacheCleared', fdo._sourceForPidAndName.size === 0);
        // Identity against the prototype's own method, NOT hasOwnProperty: restoring
        // assigns the same function back as an own property, so hasOwnProperty is true
        // either way and would be a permanently-green assertion. Both facts below come
        // from the destroy-time observer above, so an un-destroyed source (the bug they
        // guard against) cannot quietly satisfy them by being gone.
        say('mergedOpenRestored',
            !!merged && !!protoOpen && f1Observed.openRestored === true);
        // Three distinct residues, one per layer the reset used to orphan:
        say('destroyHandlerDetached', f1Observed.handlerGone === true);
        say('guardsRestoredToPristine',
            ml.Message.prototype.unexpand === pUnexpand &&
            ml.NotificationMessageGroup.prototype.collapse === pCollapse &&
            ml.NotificationMessage.prototype.close === pClose);
        out.rss = rss;

        // ---- P4: settings ----
        //
        // Four keys, each with a behaviour that must be observable *without a logout*:
        // the harness writes through a second Gio.Settings on the same schema, exactly
        // like the prefs dialog does. Each assertion is a differential (merging vs not,
        // 3 cards vs 10), so a settings layer that silently never took effect cannot
        // pass.
        inst.enable();
        await sleep(1200);
        const st = inst.getSettings();
        const allSources = () => [...Main.messageTray.getSources()];
        const titled = t => allSources().filter(s => s.title === t);
        const sendWait = async (name, n, gap) => {
            for (let i = 0; i < n; i++) {
                N(name, 'card' + i);
                await sleep(gap);
            }
        };
        say('settingsHandlerCount', inst._settingsHids.length);

        // FDO end-to-end: native maps a Notification's destroy reason onto the reason of the
        // NotificationClosed it emits (notificationDaemon.js:178-195). The signal is broadcast by
        // the shell itself, and **a bus never delivers a broadcast back to its own sender**, so
        // subscribing from inside the shell process would never receive it — a small monitor on the
        // same bus is required. The monitor starts before the trim phase, during which there is no
        // other source of closes: these notifications are urgency=critical (they never expire on
        // their own), so the only things that emit NotificationClosed are us and the oldest card
        // native trimmed.
        const monArg = 'type=signal,interface=org.freedesktop.Notifications,' +
            'member=NotificationClosed';
        const [, monPid] = GLib.spawn_async(null,
            ['/bin/sh', '-c', 'exec dbus-monitor ' + monArg + ' > ' + MON + ' 2>&1'],
            null, GLib.SpawnFlags.DEFAULT, null, null);

        // 1) max-per-source lowered to 3: five sends, three survive, oldest dropped
        st.set_int('max-per-source', 3);
        await sendWait('CapProbe', 5, 400);
        await sleep(600);
        say('capTrimmedTo', titled('CapProbe').reduce(
            (m, s) => Math.max(m, s.notifications.length), 0));
        say('capIsOneSource', titled('CapProbe').length);

        // 1a) the reason we hand the destroyed cards. FdoNotification's own 'destroy'
        //     handler maps that reason onto the FDO NotificationClosed signal
        //     (EXPIRED -> 1, DISMISSED -> 2, SOURCE_CLOSED -> 3, anything else -> 4),
        //     so getting it wrong tells the *sender* that the user dismissed a card it
        //     never touched. The signal itself cannot be observed from this process
        //     (a bus does not deliver a broadcast back to its sender), hence observing
        //     the input of that mapping rather than its output.
        const { NotificationDestroyedReason: NDR } =
            await import('resource:///org/gnome/shell/ui/messageTray.js');
        const capSource = titled('CapProbe')[0];
        const closedReasons = [];
        for (const n of capSource.notifications)
            n.connect('destroy', (self_, reason) => closedReasons.push(reason));
        st.set_int('max-per-source', 2);   // trimming an existing stack
        await sleep(400);
        N('CapProbe', 'evict one more');
        await sleep(600);
        say('evictReasons', [...new Set(closedReasons)].join(','));
        say('evictReasonIsExpired',
            closedReasons.length > 0 &&
            closedReasons.every(r => r === NDR.EXPIRED));
        say('capTrimImmediateAndSendsAgree',
            titled('CapProbe').length === 1 &&
            titled('CapProbe')[0].notifications.length === 2);
        st.set_int('max-per-source', 3);

        // 1b) endpoints of the schema range. 1 is "only the newest card", 10 must be
        //     indistinguishable from native MAX_NOTIFICATIONS_PER_SOURCE.
        st.set_int('max-per-source', 1);
        await sleep(200);
        await sendWait('CapOne', 3, 400);
        await sleep(600);
        say('capOneSources', titled('CapOne').length);
        say('capOneKeeps', titled('CapOne').reduce(
            (m, s) => Math.max(m, s.notifications.length), 0));
        st.set_int('max-per-source', 10);
        await sleep(200);
        await sendWait('CapTen', 13, 250);
        await sleep(800);
        say('capTenKeeps', titled('CapTen').reduce(
            (m, s) => Math.max(m, s.notifications.length), 0));
        say('capTenSources', titled('CapTen').length);

        // 1c) above the native ceiling. 13 sends with cap=30 must all survive in one stack —
        //     native cannot do that, it drops inside addNotification before the push. Then back
        //     to 10: the override must unmount AND the live stack must shrink in the same beat,
        //     which is what proves the mount follows the setting rather than enable(). The own
        //     property is the whole patch (addNotification lives on the prototype), so
        //     hasOwnProperty is the mount state, read from outside the extension.
        st.set_int('max-per-source', 30);
        await sleep(200);
        await sendWait('CapHigh', 13, 200);
        await sleep(900);
        say('capHighKeeps', titled('CapHigh').reduce(
            (m, s) => Math.max(m, s.notifications.length), 0));
        say('capHighSources', titled('CapHigh').length);
        say('capHighOverrideMounted', (() => {
            const s = titled('CapHigh')[0];
            return !!s && Object.prototype.hasOwnProperty.call(s, 'addNotification');
        })());
        st.set_int('max-per-source', 10);
        await sleep(500);
        say('capBackToNativeKeeps', titled('CapHigh').reduce(
            (m, s) => Math.max(m, s.notifications.length), 0));
        say('capBackToNativeUnmounted', (() => {
            const s = titled('CapHigh')[0];
            return !!s && !Object.prototype.hasOwnProperty.call(s, 'addNotification');
        })());

        // Stop the monitor and read what it saw. A count of 0 is not a product failure but an
        // instrument that never attached — the FAIL text carries the count so the two cases are
        // distinguishable at a glance.
        GLib.spawn_async(null,
            ['/bin/sh', '-c', 'kill ' + monPid + ' 2>/dev/null; true'],
            null, GLib.SpawnFlags.DEFAULT, null, null);
        await sleep(400);
        let monTxt = '';
        try {
            monTxt = new TextDecoder().decode(GLib.file_get_contents(MON)[1]);
        } catch (e) {
            out.monReadFailed = String(e && e.message ? e.message : e);
        }
        const monReasons = [...monTxt.matchAll(
            /member=NotificationClosed\s+uint32\s+(\d+)\s+uint32\s+(\d+)/g)
        ].map(m => Number(m[2]));
        say('fdoClosedObserved', monReasons.length);
        say('fdoClosedReasons', monReasons.join(','));
        say('fdoClosedAllExpired',
            monReasons.length > 0 && monReasons.every(r => r === 1));

        // 1d) disable() has to undo the addNotification override too. Read from inside the
        //     source's own 'destroy' handler, which runs before run_dispose()
        //     (messageTray.js:605-608) — reading it after disable() would touch a disposed
        //     wrapper and log a Gjs-CRITICAL whose stack repeats the wrapper frame, which is
        //     what the F1 section above documents.
        //
        //     It runs AFTER the monitor is stopped on purpose: disable() retires every merged
        //     card, and those reach the sender as DISMISSED(2) — Source.destroy(reason) hands
        //     its undefined along to Notification.destroy, whose default parameter turns it
        //     into DISMISSED. Measured: 22 reason-2 events from one disable(). Counting them
        //     inside the trim window would make the EXPIRED-only reading above fail for a
        //     reason that has nothing to do with trimming.
        st.set_int('max-per-source', 30);
        await sleep(200);
        N('CapHigh', 'mounted again');
        await sleep(500);
        const capHighSrc = titled('CapHigh')[0];
        const capObserved = {};
        if (capHighSrc) {
            capObserved.mountedBeforeDisable =
                Object.prototype.hasOwnProperty.call(capHighSrc, 'addNotification');
            capHighSrc.connect('destroy', () => {
                capObserved.addRestored =
                    !Object.prototype.hasOwnProperty.call(capHighSrc, 'addNotification');
            });
        }
        out.capSetup = capObserved;
        inst.disable();
        inst.enable();
        st.set_int('max-per-source', 10);
        await sleep(1500);
        say('capOverrideRestoredOnDisable', capObserved.addRestored === true);

        // 2) grouping off: sends must NOT merge (one source per pid)
        st.set_boolean('grouping-enabled', false);
        await sleep(200);
        await sendWait('SoloProbe', 2, 500);
        await sleep(600);
        say('groupingOffSourceCount', titled('SoloProbe').length);

        // 3) grouping back on + that name isolated: still not merged
        st.set_boolean('grouping-enabled', true);
        st.set_strv('isolate-apps', ['IsoProbe']);
        await sleep(200);
        await sendWait('IsoProbe', 2, 500);
        await sleep(600);
        say('isolatedSourceCount', titled('IsoProbe').length);
        say('isolatedInCache', inst._isolated.has('isoprobe'));
        // a non-isolated name still merges, so the previous two lines cannot be
        // explained by grouping having broken in general
        await sendWait('MergesStill', 2, 500);
        await sleep(600);
        say('nonIsolatedMerged', titled('MergesStill').length === 1 &&
            titled('MergesStill')[0].notifications.length === 2);

        // 4) guards toggle is reversible in both directions, with no residue
        const protoIdentityPristine = () =>
            ml.Message.prototype.unexpand === pUnexpand &&
            ml.NotificationMessageGroup.prototype.collapse === pCollapse &&
            ml.NotificationMessage.prototype.close === pClose;
        st.set_boolean('ui-guards', false);
        await sleep(400);
        say('guardsOffDetached', Uw.applied().length === 0 && protoIdentityPristine());
        st.set_boolean('ui-guards', true);
        await sleep(1600);
        say('guardsOnReattached', Uw.applied().length === 3);

        // 4b) the fall-through diagnostic. IsoProbe is isolated above, so every send there
        //     takes the silent not-mergeable branch. Four sends, of which only the first two
        //     may be written — the count is taken from the shell log on the python side, so
        //     "off stays silent" and "on writes one line each" are one measurement read twice.
        st.set_boolean('log-fallthrough', true);
        await sleep(200);
        await sendWait('IsoProbe', 2, 400);
        st.set_boolean('log-fallthrough', false);
        await sleep(200);
        await sendWait('IsoProbe', 2, 400);
        say('fallthroughSends', 4);

        // 4c) adoption of the pre-enable window — the login race. The daemon answers Notify
        //     before ExtensionSystem gets to enable(), so a session-start sender keeps a native
        //     per-pid stack that nothing merges into afterwards. Disable, send once (native
        //     makes its own source), enable (attach adopts it), send again: both cards must end
        //     in ONE stack. Then disable and check the adopted stack was handed back rather than
        //     retired — its cards were never ours, and "disabling tears down only what this
        //     extension created" is the promise on the line.
        inst.disable();
        await sendWait('AdoptProbe', 1, 400);
        await sleep(600);
        say('adoptNativeOnly', titled('AdoptProbe').length);
        inst.enable();
        await sleep(1500);
        say('adoptKeysAfterEnable', [...inst._shared.keys()]);
        await sendWait('AdoptProbe', 1, 400);
        await sleep(600);
        say('adoptedSourceCount', titled('AdoptProbe').length);
        say('adoptedCardCount', titled('AdoptProbe').length === 1
            ? titled('AdoptProbe')[0].notifications.length : -1);
        inst.disable();
        await sleep(400);
        say('adoptedSurvivesDisableSources', titled('AdoptProbe').length);
        say('adoptedSurvivesDisableCards', titled('AdoptProbe').length === 1
            ? titled('AdoptProbe')[0].notifications.length : -1);
        inst.enable();
        await sleep(1500);

        // 5) cleanup obligation created by the settings layer: every changed:: handler
        //    must be disconnected by disable(), and the settings object dropped.
        const settingsRef = inst._settings;
        const hids = [...inst._settingsHids];
        inst.disable();
        // Only one pair is reported. The collector assigns out[k] = v, so a second
        // say() under the same key would drop the first without a word -- which is what
        // used to happen here. This pair runs after the second disable(), so it also
        // covers the first round's handlers; settingsHandlerCount already pins arming.
        inst.disable();
        say('settingsHandlersDetached', hids.length > 0 &&
            hids.every(id => GObject.signal_handler_is_connected(settingsRef, id) === false));
        say('settingsDropped',
            inst._settings === null && inst._settingsHids.length === 0);
        // Fourth RSS point: after everything is torn down. Report-only, like the others —
        // it answers "did the extension's own footprint come back down", which no
        // assertion here can claim. Absent when the settings phase threw earlier.
        rss.afterDisable = rssKiB();
    } catch (e) {
        out.error = String(e && e.message ? e.message : e) + ' @ ' +
            (e && e.fileName || '?') + ':' + (e && e.lineNumber || '?');
        if (e && e.stack) out.stack = String(e.stack).split('\\n').slice(0, 6).join(' | ');
    }
    GLib.file_set_contents('$RES', JSON.stringify(out, null, 2));
})();
JSPROBE

dbus-run-session -- bash -c '
export GSETTINGS_BACKEND=memory XDG_DATA_HOME="'"$V"'/xdg-'"$LABEL"'" WAYLAND_DISPLAY='"$WD"'
cd "'"$V"'"
gnome-shell --headless --wayland-display='"$WD"' --virtual-monitor 1280x800 --unsafe-mode > log-'"$LABEL"'.txt 2>&1 &
SP=$!
ready=0
for i in $(seq 1 60); do
  kill -0 $SP 2>/dev/null || { echo "SHELL DIED"; grep -iE "error|exception" log-'"$LABEL"'.txt | tail -12; exit 1; }
  if gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval "true" 2>/dev/null \
       | grep -q "^(true,"; then ready=1; echo "shell ready after ${i}s"; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "EVAL NEVER READY"; tail -30 log-'"$LABEL"'.txt; exit 1; }
sleep 1
gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval \
  "eval(imports.byteArray.toString(imports.gi.GLib.file_get_contents(\"'"$V"'/probe-'"$LABEL"'.js\")[1]))" >/dev/null 2>&1
for i in $(seq 1 60); do [ -s "'"$RES"'" ] && break; sleep 1; done
kill $SP 2>/dev/null; wait $SP 2>/dev/null; true'

cat "$RES" 2>/dev/null || { echo "MISSING (probe never wrote)"; exit 1; }
echo
echo "=== extension log lines ==="
grep -i 'notification-grouper' "$V/log-$LABEL.txt" || echo "(none)"

# ---- assertions ----
echo
echo "=== assertions ==="
python3 - "$RES" "$V/log-$LABEL.txt" <<'PY'
import json, re, sys, collections
d = json.load(open(sys.argv[1]))
log = open(sys.argv[2], errors='replace').read()
# Recursion shows up as the SAME extension.js line repeating inside one stack.
# Counting matches of r'extension\.js:1\d\d' stopped matching anything the moment the
# wrappers moved past line 199: a permanently green assertion that guards nothing.
hits = collections.Counter(re.findall(r'extension\.js:(\d+)', log))
repeated = sorted((f"{ln}x{n}" for ln, n in hits.items() if n >= 3))
# disable() prints the guards it "restored". A wrapper layer can survive that line, so
# the claim is only trustworthy when compared against prototype identity.
disable_lines = re.findall(r'disabled, restored patches:.*', log)
claimed = ''
if disable_lines:
    tail = disable_lines[-1]
    claimed = tail.split('guards:')[-1].strip() if 'guards:' in tail else ''
guards_claimed = claimed not in ('', '(none)')
# The diagnostic switch's own output, counted from the shell log rather than from inside
# the shell: the branch it reports is a log line, and that is the promise being made.
ftLines = len(re.findall(r'fall-through branch=', log))
f1 = d.get('f1Setup') or {}
capSetup = d.get('capSetup') or {}
checks = [
    ('no probe error',                 'error' not in d,        d.get('error', '')),
    ('daemon reachable',               d.get('haveFdo') is True, ''),
    ('guard prototypes judgeable',     d.get('havePrototypes') is True,
     'messageList classes missing — every guard-restoration assertion below is vacuous'),
    ('patches installed on enable',    d.get('wrapperInstalled') is True, ''),
    ('double-enable restores pristine', d.get('restoredPristine') is True,
     'the _attach idempotency invariant broke'),
    ('re-attach after detach',         d.get('reattached') is True, ''),
    ('4 notifications -> 2 sources',   d.get('sourceCount') == 2,
     'got %r' % d.get('sourceCount')),
    ('3 same-name pids merged',        3 in (d.get('notifCounts') or []),
     'got %r' % d.get('notifCounts')),
    ('group keys as declared',         sorted(d.get('sharedKeys') or []) ==
                                       ['app:verifymerge', 'app:verifyother'],
     'got %r' % d.get('sharedKeys')),
    ('app_name guard silent',          d.get('warnedKeys') == [],
     'guard misfired: %r' % d.get('warnedKeys')),
    ('native cached one pid per group', len(d.get('nativePidKeys') or []) == 2,
     'got %r' % d.get('nativePidKeys')),
    ('no repeated extension.js frame', not repeated,
     'same line >=3x (recursion or a repeating error): %s' % ', '.join(repeated)),
    ('merged source recognised',       d.get('mergedIsOwned') is True, ''),
    ('open() does not wipe the group', (d.get('mergedNotifsBeforeOpen') or 0) >= 3 and
                                       d.get('mergedNotifsAfterOpen') == d.get('mergedNotifsBeforeOpen'),
     'before %r after %r' % (d.get('mergedNotifsBeforeOpen'), d.get('mergedNotifsAfterOpen'))),
    # Same click, the other promise: the page closes only once the stack is down to the
    # card that was clicked. Both directions are judged, so "always closes" and "never
    # closes" both go red here.
    ('open() with cards left keeps the page open',
     d.get('openWithCardsLeftClosedPage') is True and
     (d.get('openWithCardsLeftCount') or 0) >= 2,
     'closed %r with %r cards still in the stack'
     % (d.get('openWithCardsLeftClosedPage'), d.get('openWithCardsLeftCount'))),
    ('open() on the last card closes the page',
     d.get('mergedDownToOne') == 1 and d.get('openOnLastCardClosedPage') is True,
     'down to %r, page closed %r' % (d.get('mergedDownToOne'), d.get('openOnLastCardClosedPage'))),
    # ---- F1: enable() must be idempotent for ALL THREE patch layers ----
    ('F1 probe reached a live source', f1.get('recordFound') is True and
                                       f1.get('handlerFound') is True and
                                       f1.get('prototypeOpenFound') is True,
     'got %r — the four assertions below would be vacuous' % (f1,)),
    ('guards mounted before judging',  d.get('guardsMountedBeforeJudging') is True,
     'the async attach had not resolved, so restoration was never testable'),
    ('record survives re-enable',      d.get('recordSurvivesReenable') is True,
     'enable() reset _shared: the open() override and its destroy handler are orphaned'),
    ('own-source survives re-enable',  d.get('ownSourceSurvivesReenable') is True,
     'close-guard lost this source: "close one card" silently reverts to "close the group"'),
    ('merged open() restored',         d.get('mergedOpenRestored') is True,
     'a patched open() is still on the source after disable() — residue no owner can undo'),
    ('destroy handler detached',       d.get('destroyHandlerDetached') is True,
     'signal left connected; its closure retains the extension instance for the session'),
    ('merged source destroyed on disable', d.get('sourceDestroyedByDisable') is True,
     'our own source outlived disable(): it still holds a watch_name and a NotificationPolicy, '
     'and the restored native open() wipes the whole group (F6)'),
    ('native pid cache self-cleaned',  d.get('nativePidCacheCleared') is True,
     'destroy did not trip notificationDaemon.js:126 — native would next hand back a disposed source'),
    ('guards restored to pristine',    d.get('guardsRestoredToPristine') is True,
     'a wrapper layer is still live on the native prototypes after disable()'),
    ('disable log matches reality',    (not guards_claimed) or
                                        d.get('guardsRestoredToPristine') is True,
     'disable() logged "guards: %s" while a wrapper was still installed' % claimed),
    ('disable restored cleanly',       d.get('finalRestored') is True, ''),
    # ---- P4: settings must change behaviour without a logout ----
    ('five changed:: handlers armed',  d.get('settingsHandlerCount') == 5,
     'got %r' % d.get('settingsHandlerCount')),
    ('max-per-source=3 trims to 3',    d.get('capTrimmedTo') == 3,
     'longest source holds %r' % d.get('capTrimmedTo')),
    ('cap still merges into one source', d.get('capIsOneSource') == 1,
     'got %r sources — trimming must not split the group' % d.get('capIsOneSource')),
    # ---- trimming must not lie to the sender about WHY a card left ----
    ('evicted cards report EXPIRED',   d.get('evictReasonIsExpired') is True,
     'reasons seen: %r — anything but EXPIRED(1) tells the sender the user dismissed it'
     % d.get('evictReasons')),
    ('lowering the cap trims at once', d.get('capTrimImmediateAndSendsAgree') is True,
     'a cap change must shrink the live stack before the next notification arrives'),
    ('cap=1 keeps one card, still one source',
     d.get('capOneKeeps') == 1 and d.get('capOneSources') == 1,
     'keeps %r across %r sources' % (d.get('capOneKeeps'), d.get('capOneSources'))),
    ('cap=10 matches the native ceiling', d.get('capTenKeeps') == 10 and
                                          d.get('capTenSources') == 1,
     '13 sends left %r cards in %r sources (native would keep 10)'
     % (d.get('capTenKeeps'), d.get('capTenSources'))),
    # ---- above the native ceiling: the override is the only thing between 10 and 30 ----
    ('cap=30 keeps every card native would drop',
     d.get('capHighKeeps') == 13 and d.get('capHighSources') == 1,
     '13 sends left %r cards in %r sources (native alone keeps 10)'
     % (d.get('capHighKeeps'), d.get('capHighSources'))),
    ('the override mounts above 10 and unmounts at it',
     d.get('capHighOverrideMounted') is True and d.get('capBackToNativeUnmounted') is True,
     'mounted %r, unmounted %r' % (d.get('capHighOverrideMounted'),
                                   d.get('capBackToNativeUnmounted'))),
    ('lowering to the native ceiling trims the live stack at once',
     d.get('capBackToNativeKeeps') == 10, 'got %r' % d.get('capBackToNativeKeeps')),
    ('disable() removes the addNotification override',
     capSetup.get('mountedBeforeDisable') is True and
     d.get('capOverrideRestoredOnDisable') is True,
     'mounted before disable %r, restored %r — without the first the second is vacuous'
     % (capSetup.get('mountedBeforeDisable'), d.get('capOverrideRestoredOnDisable'))),
    # ---- the reason must survive the trip onto the bus, not just inside the shell ----
    ('FDO sees EXPIRED for evicted cards', d.get('fdoClosedAllExpired') is True,
     'captured %r NotificationClosed (reasons %r) — 0 means the monitor never attached '
     '(instrument failure, not a product verdict); anything but 1 means we told the '
     'sender something else happened'
     % (d.get('fdoClosedObserved'), d.get('fdoClosedReasons'))),
    ('grouping off stops merging',     d.get('groupingOffSourceCount') == 2,
     'got %r sources for 2 sends (2 expected: per-pid, native behaviour)' % d.get('groupingOffSourceCount')),
    ('isolate-apps keeps that app apart', d.get('isolatedSourceCount') == 2,
     'got %r' % d.get('isolatedSourceCount')),
    ('exception list reached the cache', d.get('isolatedInCache') is True,
     'got %r' % d.get('isolatedInCache')),
    ('other apps still merge (control)', d.get('nonIsolatedMerged') is True,
     'control assertion: without it the two lines above could be "grouping broke entirely"'),
    ('ui-guards off detaches them',    d.get('guardsOffDetached') is True,
     'a wrapper is still live on the prototypes after turning the switch off'),
    ('ui-guards on re-attaches them',  d.get('guardsOnReattached') is True,
     'got %r applied' % d.get('guardsOnReattached')),
    # 4 isolated sends took the silent fall-through branch, the switch on for the first
    # two only. Exactly 2 lines is the single reading that judges both directions: 4 means
    # "off" still logs, 0 means "on" logs nothing.
    ('log-fallthrough writes one line per skipped merge',
     d.get('fallthroughSends') == 4 and ftLines == 2,
     'got %r fall-through lines for 4 sends (want exactly 2: 2 logged, 2 silent)'
     % ftLines),
    # ---- adoption: the stack that arrived before enable() must not stay a stranger ----
    ('a pre-enable stack is adopted, not duplicated',
     d.get('adoptNativeOnly') == 1 and d.get('adoptedSourceCount') == 1 and
     d.get('adoptedCardCount') == 2,
     'native %r -> after adoption %r sources / %r cards (want 1 source, 2 cards)'
     % (d.get('adoptNativeOnly'), d.get('adoptedSourceCount'), d.get('adoptedCardCount'))),
    ('adopted key rebuilt from the declared title',
     'app:adoptprobe' in (d.get('adoptKeysAfterEnable') or []),
     'got %r' % (d.get('adoptKeysAfterEnable'),)),
    ('disable hands an adopted stack back instead of retiring it',
     d.get('adoptedSurvivesDisableSources') == 1 and d.get('adoptedSurvivesDisableCards') == 2,
     '%r sources / %r cards after disable (want 1/2 — its cards were never ours)'
     % (d.get('adoptedSurvivesDisableSources'), d.get('adoptedSurvivesDisableCards'))),
    ('disable disconnects settings',   d.get('settingsHandlersDetached') is True,
     'changed:: handlers left connected — the cleanup obligation the settings layer adds'),
    ('disable drops the settings object', d.get('settingsDropped') is True, ''),
]
bad = 0
for name, ok, extra in checks:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  ' + str(extra) if extra and not ok else ''}")
    bad += 0 if ok else 1
print(f"\n{len(checks)-bad}/{len(checks)} passed")
# RSS is recorded, never asserted: font caching and GPU buffers dominate the delta in a
# headless shell, so a threshold here would fail for reasons unrelated to the extension.
# It exists so a later run can be compared against this one.
rss = d.get('rss') or {}
if rss:
    pt = lambda k: ('%s KiB' % rss[k]) if rss.get(k) is not None else '(not sampled)'
    print("RSS (report only): baseline %s -> after burst %s -> after re-enable %s -> after disable %s"
          % (pt('baseline'), pt('afterBurst'), pt('afterReenable'), pt('afterDisable')))
sys.exit(1 if bad else 0)
PY
