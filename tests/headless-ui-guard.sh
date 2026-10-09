#!/bin/bash
# usage: tests/headless-ui-guard.sh [<extension-dir>] [<label>]
#
# Provocation harness for the GNOME 50 collapse defect worked around in
# uiWorkarounds.js. It ASSERTS now (it used to only cat the JSON and grep counts, so the
# required "flip" was a human two-run diff and could never gate anything).
#
#   EXPECT=guarded  (default) — the working tree: the guard must absorb the fault
#   EXPECT=native             — a pre-fix build (git archive HEAD | tar -x): the fault
#                               must reach the caller and corrupt the group state
#
# Run it once with each value and the FLIP is machine-checked:
#   git archive HEAD | tar -x -C /tmp/ng-pre && EXPECT=native tests/headless-ui-guard.sh /tmp/ng-pre pre
#   EXPECT=guarded          tests/headless-ui-guard.sh
#
# Provokes the native messageList collapse fault on BOTH builds, so the guard is
# shown to matter rather than merely to not crash:
#   native (pre-fix):  JS ERROR logged, group stays _expanded=true (state corrupts),
#                      messages after the broken one never get unexpanded
#   patched:           no JS ERROR, _expanded=false, cover shown, forEach completes
set -u
EXT=${1:-$(CDIR=$(cd "$(dirname "$0")/.." && pwd) && echo "$CDIR")}
LABEL=${2:-guard}
V=${TMPDIR:-/tmp}/ng-verify
# metadata stub 必须带 settings-schema，否则 enable() 里的 getSettings() 抛出。
SCHEMA=$(sed -n 's/.*"settings-schema"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EXT/metadata.json")
[ -n "$SCHEMA" ] || { echo "metadata.json has no settings-schema" >&2; exit 1; }
EXPECT=${EXPECT:-guarded}
case "$EXPECT" in guarded|native) ;; *) echo "EXPECT must be 'guarded' or 'native', got '$EXPECT'" >&2; exit 2 ;; esac
UUID=notification-grouper@local
STAGED="$V/xdgu-$LABEL/gnome-shell/extensions/$UUID"
WD=wayland-u$LABEL
RES="$V/res-u-$LABEL.json"
LOG="$V/log-u-$LABEL.txt"

rm -rf "$V/xdgu-$LABEL" "$RES" "$LOG"
mkdir -p "$V/xdgu-$LABEL/gnome-shell/extensions"
cp -a "$EXT" "$STAGED"; rm -rf "$STAGED/.git"
md5sum "$STAGED/extension.js" | sed 's/^/staged /'

cat > "$V/probe-u-$LABEL.js" <<JSPROBE
(async () => {
    const out = { checks: {} };
    const GLib = imports.gi.GLib;
    const Gio = imports.gi.Gio;
    const EXTDIR = '$STAGED';
    const say = (k, v) => { out.checks[k] = v; };
    try {
        const Main = await import('resource:///org/gnome/shell/ui/main.js');
        const ml = await import('resource:///org/gnome/shell/ui/messageList.js');
        const mod = await import('file://' + EXTDIR + '/extension.js');
        const Uw = await import('file://' + EXTDIR + '/uiWorkarounds.js');

        // three real notifications on one source -> one real group of three
        const spawn = a => GLib.spawn_async(null,
            ['notify-send', '--urgency=critical', '--app-name=' + a, 't', 'b'],
            null, GLib.SpawnFlags.SEARCH_PATH, null, null)[0];
        const sleep = ms => new Promise(r => GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.Source.REMOVE; }));
        const inst = new mod.default({
            uuid: '$UUID', name: 'Notification Grouper', 'shell-version': ['50'],
            'settings-schema': '$SCHEMA',
            dir: Gio.File.new_for_path(EXTDIR), path: EXTDIR,
        });
        inst.enable();

        // enable FIRST: before the grouping patch is mounted, three sends make
        // three separate sources with one notification each, so a group of three
        // cannot exist yet (that is what made the first run's mapSize 1).
        let src = null;
        for (let i = 0; i < 20; i++) {
            src = [...Main.messageTray.getSources()].find(s => s.title === 'UiProbe');
            if (src && src.notifications.length >= 3)
                break;
            if (i % 3 === 0)
                spawn('UiProbe');
            await sleep(300);
        }
        say('guardsAttached', Uw.applied());
        if (!src) { out.error = 'no UiProbe source'; GLib.file_set_contents('$RES', JSON.stringify(out, null, 2)); return; }
        say('sourceNotifs', src.notifications.length);
        if (src.notifications.length < 3) {
            out.error = 'fewer than 3 notifications on one source; the "loop ran past the broken entry" assertion would be vacuous';
            GLib.file_set_contents('$RES', JSON.stringify(out, null, 2));
            return;
        }

        const group = new ml.NotificationMessageGroup(src);
        await group.expand();
        say('expandedBefore', group._expanded);

        const msgs = [...group._notificationToMessage.values()];
        say('mapSize', msgs.length);
        const broken = msgs[0];
        const healthy = msgs.slice(1);
        broken._bodyBin.set_layout_manager(null);
        say('brokenHasLayout', !!broken._bodyBin.layout_manager);
        say('brokenMapped', !!broken._bodyBin.mapped);
        say('healthyAllHaveLayout', healthy.every(m => !!m._bodyBin.layout_manager));
        say('healthyExpandedBefore', healthy.map(m => m.expanded));

        let threw = false;
        try {
            await group.collapse();
        } catch (e) {
            threw = true;
            out.collapseRejection = String(e && e.message || e).slice(0, 100);
        }
        await sleep(400);

        say('collapseThrewToCaller', threw);
        say('expandedAfter', group._expanded);
        say('coverShown', group._cover.visible);
        // the differentiator for "did the loop run past the broken entry?"
        say('healthyExpandedAfter', healthy.map(m => m.expanded));
        say('brokenMessageExpanded', broken.expanded);

        // Regression (extension behaviour, same run): in a COLLAPSED merged group,
        // closing one card must destroy only that notification. Native
        // messageList.js:1107-1112 upgrades the close to group.close(), wiping the whole
        // merged stack — invisible natively (one card per source), costly after
        // merging. A fresh group is used so the doctored 'broken' actor above does
        // not leak in. Expected: post-fix notifsAfterClose = notifsBeforeClose - 1;
        // native/pre-fix notifsAfterClose = 0 (entire group closed).
        const closeGroup = new ml.NotificationMessageGroup(src);
        const closeMsgs = [...closeGroup._notificationToMessage.values()];
        say('closeGroupExpanded', closeGroup.expanded);
        say('closeGroupSize', closeMsgs.length);
        say('ownSourcesHasSrc', inst._ownSources
            ? inst._ownSources.has(src) : 'field absent (pre-fix build)');
        const notifsBeforeClose = src.notifications.length;
        if (closeMsgs.length > 0)
            closeMsgs[0].close();
        await sleep(400);
        say('notifsBeforeClose', notifsBeforeClose);
        say('notifsAfterClose', src.notifications.length);

        inst.disable();
    } catch (e) {
        out.error = String(e && e.message || e) + ' @ ' + (e && e.fileName || '?') + ':' + (e && e.lineNumber || '?');
        if (e && e.stack) out.stack = String(e.stack).split('\\n').slice(0, 5).join(' | ');
    }
    GLib.file_set_contents('$RES', JSON.stringify(out, null, 2));
})();
JSPROBE

dbus-run-session -- bash -c '
export GSETTINGS_BACKEND=memory XDG_DATA_HOME="'"$V"'/xdgu-'"$LABEL"'" WAYLAND_DISPLAY='"$WD"'
cd "'"$V"'"
gnome-shell --headless --wayland-display='"$WD"' --virtual-monitor 1280x800 --unsafe-mode > "'"$LOG"'" 2>&1 &
SP=$!
ready=0
for i in $(seq 1 60); do
  kill -0 $SP 2>/dev/null || { echo "SHELL DIED"; tail -12 "'"$LOG"'"; exit 1; }
  if gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval "true" 2>/dev/null \
       | grep -q "^(true,"; then ready=1; echo "ready ${i}s"; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "EVAL NEVER READY"; exit 1; }
sleep 1
gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval \
  "eval(imports.byteArray.toString(imports.gi.GLib.file_get_contents(\"'"$V"'/probe-u-'"$LABEL"'.js\")[1]))" >/dev/null 2>&1
for i in $(seq 1 25); do [ -s "'"$RES"'" ] && break; sleep 1; done
kill $SP 2>/dev/null; wait $SP 2>/dev/null; true'

echo "=== [$LABEL] checks ==="
cat "$RES" 2>/dev/null || { echo MISSING; exit 1; }
# The two counters that used to sit here ("TypeError … 次数", "collapse@messageList 栈帧次数")
# read 0 in BOTH modes: collapse() is awaited inside the probe, so the fault is caught and
# never reaches the shell's default handler. A line that says "0" either way is not evidence,
# so the reason is asserted from collapseRejection below instead.
echo "=== [$LABEL] extension log ==="
grep -i 'notification-grouper' "$LOG" | sed 's/^.*gnome-shell[^ ]*: //'

# ---- assertions ----
# The provocation is only worth running if its OUTCOME is judged, not read by eye.
# Preconditions are asserted first: a run that never entered the fault branch would
# otherwise "pass" in guarded mode by proving nothing at all.
echo
echo "=== [$LABEL] assertions (EXPECT=$EXPECT) ==="
python3 - "$RES" "$EXPECT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
expect = sys.argv[2]
c = d.get('checks', {})
pre = [
    ('no probe error',              'error' not in d, d.get('error', '')),
    ('3+ notifications on one source', (c.get('sourceNotifs') or 0) >= 3,
     'got %r — a one-card group cannot host the fault' % c.get('sourceNotifs')),
    ('group really holds those messages', (c.get('mapSize') or 0) >= 3,
     'got %r' % c.get('mapSize')),
    ('fault branch really entered',  c.get('brokenHasLayout') is False,
     'the doctored message still had a layout manager, so nothing was provoked'),
    ('the other messages were healthy', c.get('healthyAllHaveLayout') is True,
     'got %r' % c.get('healthyAllHaveLayout')),
    ('source owned by the extension', c.get('ownSourcesHasSrc') is True,
     'got %r — the close guard cannot be judged without it' % c.get('ownSourcesHasSrc')),
]
if expect == 'guarded':
    main = [
        ('collapse did not reach the caller', c.get('collapseThrewToCaller') is False,
         'rejection %r' % d.get('collapseRejection', '')),
        ('group state landed (expanded=false)', c.get('expandedAfter') is False,
         'got %r — half-collapsed is the state that swallows every later click' % c.get('expandedAfter')),
        ('cover re-shown',                 c.get('coverShown') is True, 'got %r' % c.get('coverShown')),
        ('closing one card closed one card',
         c.get('notifsBeforeClose') is not None and
         c.get('notifsAfterClose') == c.get('notifsBeforeClose') - 1,
         'before %r after %r' % (c.get('notifsBeforeClose'), c.get('notifsAfterClose'))),
    ]
else:
    main = [
        ('collapse reached the caller (native fault present)',
         c.get('collapseThrewToCaller') is True, 'got %r' % c.get('collapseThrewToCaller')),
        ('group left corrupted (expanded=true)', c.get('expandedAfter') is True,
         'got %r' % c.get('expandedAfter')),
        ('cover never shown',                c.get('coverShown') is False, 'got %r' % c.get('coverShown')),
        ('native close wiped the whole group',
         c.get('notifsAfterClose') == 0,
         'before %r after %r' % (c.get('notifsBeforeClose'), c.get('notifsAfterClose'))),
        # The rejection must be the KNOWN native fault, not some unrelated throw:
        # 'can't access property "expansion", obj is null' from ease_property on an
        # actor whose layout manager is gone (environment.js:196 raises synchronously).
        ('rejection is the known native TypeError',
         'expansion' in (d.get('collapseRejection') or ''),
         'got %r' % d.get('collapseRejection', '')),
    ]
bad = 0
for name, ok, extra in pre + main:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  ' + str(extra) if extra and not ok else ''}")
    bad += 0 if ok else 1
print(f"\n{len(pre + main) - bad}/{len(pre + main)} passed  (EXPECT={expect})")
sys.exit(1 if bad else 0)
PY
