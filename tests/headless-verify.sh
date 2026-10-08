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
set -u

EXT=${1:-$(CDIR=$(cd "$(dirname "$0")/.." && pwd) && echo "$CDIR")}
V=${TMPDIR:-/tmp}/ng-verify
UUID=notification-grouper@local
LABEL=verify
STAGED="$V/xdg-$LABEL/gnome-shell/extensions/$UUID"
WD=wayland-$LABEL
RES="$V/res-$LABEL.json"

rm -rf "$V/xdg-$LABEL" "$RES" "$V/log-$LABEL.txt"
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
    try {
        const Main = await import('resource:///org/gnome/shell/ui/main.js');
        const mod = await import('file://' + EXTDIR + '/extension.js');
        const fdo = Main.notificationDaemon._fdoNotificationDaemon;
        const pNotify = fdo.NotifyAsync, pGet = fdo._getSourceForPidAndName;
        say('haveFdo', !!fdo);

        const inst = new mod.default({
            uuid: '$UUID',
            name: 'Notification Grouper',
            'shell-version': ['50'],
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

        inst.disable();
        say('finalRestored', fdo.NotifyAsync === pNotify);
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
for i in $(seq 1 25); do [ -s "'"$RES"'" ] && break; sleep 1; done
kill $SP 2>/dev/null; wait $SP 2>/dev/null; true'

cat "$RES" 2>/dev/null || { echo "MISSING (probe never wrote)"; exit 1; }
echo
echo "=== extension log lines ==="
grep -i 'notification-grouper' "$V/log-$LABEL.txt" || echo "(none)"

# ---- assertions ----
echo
echo "=== assertions ==="
python3 - "$RES" "$V/log-$LABEL.txt" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
log = open(sys.argv[2], errors='replace').read()
frames = len(re.findall(r'extension\.js:1\d\d', log))
checks = [
    ('no probe error',                 'error' not in d,        d.get('error', '')),
    ('daemon reachable',               d.get('haveFdo') is True, ''),
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
    ('no wrapper recursion',           frames == 0, '%d recursive frames' % frames),
    ('merged source recognised',       d.get('mergedIsOwned') is True, ''),
    ('open() does not wipe the group', (d.get('mergedNotifsBeforeOpen') or 0) >= 3 and
                                       d.get('mergedNotifsAfterOpen') == d.get('mergedNotifsBeforeOpen'),
     'before %r after %r' % (d.get('mergedNotifsBeforeOpen'), d.get('mergedNotifsAfterOpen'))),
    ('disable restored cleanly',       d.get('finalRestored') is True, ''),
]
bad = 0
for name, ok, extra in checks:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  ' + str(extra) if extra and not ok else ''}")
    bad += 0 if ok else 1
print(f"\n{len(checks)-bad}/{len(checks)} passed")
sys.exit(1 if bad else 0)
PY
