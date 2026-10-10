#!/bin/bash
# tests/headless-verify.sh — runtime verification of extension.js
#
# Why this file exists: `npm test` only covers groupEngine.js (pure functions).
# The two wrappers, the enable/disable contract and the _shared cache can only
# be executed by GJS inside a real shell. This script boots a throwaway headless
# GNOME Shell on a private D-Bus session and drives the extension there.
#
#   usage: tests/headless-verify.sh [<extension-dir>]
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
# settings-schema 必须从 metadata.json 取：探针是伪造 metadata 直接构造扩展的，
# stub 里少这个键，getSettings() 就会抛，然后整条断言链全变成 "got None"——
# 那看起来像设置面坏了，其实是 harness 自己的仪器缺件。
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

        // FDO 端到端：原生把 Notification 的 destroy reason 映射成发出去的
        // NotificationClosed 的 reason（notificationDaemon.js:178-195）。信号是 shell
        // 自己广播的，而**总线不会把广播信号送回给发送者**，所以在 shell 进程里
        // subscribe 永远收不到——必须起一个同总线的小监听。监听从削位阶段之前开始，
        // 期间没有任何别的关闭来源：这些通知是 urgency=critical（不超时自动消失），
        // 唯一会发 NotificationClosed 的就是我们和被原生削掉的最旧卡片。
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

        // 关掉监听并读它看到的东西。0 条不是产品红，是仪器没接上——FAIL 文案里带着
        // 计数，两种情况一眼可分。
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

        // 5) cleanup obligation created by the settings layer: every changed:: handler
        //    must be disconnected by disable(), and the settings object dropped.
        const settingsRef = inst._settings;
        const hids = [...inst._settingsHids];
        inst.disable();
        say('settingsHandlersDetached', hids.length === 4 &&
            hids.every(id => GObject.signal_handler_is_connected(settingsRef, id) === false));
        say('settingsDropped',
            inst._settings === null && inst._settingsHids.length === 0);
        inst.disable();
        say('settingsHandlersDetached', hids.length > 0 &&
            hids.every(id => GObject.signal_handler_is_connected(settingsRef, id) === false));
        say('settingsDroppedOnDisable',
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
f1 = d.get('f1Setup') or {}
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
    ('four changed:: handlers armed',  d.get('settingsHandlerCount') == 4,
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
