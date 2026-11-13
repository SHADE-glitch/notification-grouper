#!/bin/bash
# usage: test/headless-ui-guard.sh [<extension-dir>] [<label>]
#
# Provocation harness for the GNOME 50 collapse defect worked around in
# uiWorkarounds.js. It ASSERTS now (it used to only cat the JSON and grep counts, so the
# required "flip" was a human two-run diff and could never gate anything).
#
#   EXPECT=guarded  (default) — the working tree: the guard must absorb the fault
#   EXPECT=native             — a guard-free build: the fault must reach the caller and corrupt
#                               the group state.
#
# The native control is SYNTHESIZED, not checked out. It used to point at 528b234^ ("the last
# tree without the guard"), but that tree predates the settings schema (96ce1a0), so this
# script's own "metadata.json has no settings-schema" guard refused to start it: the control
# case had been unrunnable for every tree that actually shipped the settings layer, and the
# two-mode flip AGENTS claims was never executed. EXPECT=native with no <extension-dir> now
# copies the current tree and neutralizes uiWorkarounds.attach() in the copy; passing a
# directory explicitly still overrides it.
#
# Run it once with each value and the FLIP is machine-checked:
#   EXPECT=native   test/headless-ui-guard.sh
#   EXPECT=guarded  test/headless-ui-guard.sh
#
# Provokes the native messageList collapse fault on BOTH builds, so the guard is
# shown to matter rather than merely to not crash. TWO provocations, one per half of
# the guard: a doctored layout manager (absorbed by workaround 1, so collapse() never
# throws) and a throwing own-property unexpand (reaches workaround 2's catch, where the
# full post-loop state has to land — header hidden, stacked fade rewritten):
#   native (pre-fix):  JS ERROR logged, group stays _expanded=true (state corrupts),
#                      messages after the broken one never get unexpanded,
#                      fade never runs and _headerBox stays visible
#   patched:           no JS ERROR, _expanded=false, cover shown, forEach completes,
#                      fade ran and _headerBox hidden
set -u
EXT=${1:-$(CDIR=$(cd "$(dirname "$0")/.." && pwd) && echo "$CDIR")}
LABEL=${2:-guard}
V=${TMPDIR:-/tmp}/ng-verify
EXPECT=${EXPECT:-guarded}
case "$EXPECT" in guarded|native) ;; *) echo "EXPECT must be 'guarded' or 'native', got '$EXPECT'" >&2; exit 2 ;; esac
# The control tree: same tree, attach() neutralized so no guard is mounted. The assert
# below is the instrument check — if the signature drifts, the control silently becomes
# a second guarded run, which is exactly the "green but blind" failure this file exists.
if [ "$EXPECT" = native ] && [ $# -lt 1 ]; then
    PRE="$V/native-control"
    rm -rf "$PRE"
    mkdir -p "$V"
    cp -a "$EXT" "$PRE"
    rm -rf "$PRE/.git"
    python3 - "$PRE/uiWorkarounds.js" <<'PYCONTROL'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
anchor = 'export async function attach({ ownsSource, log, onError, alive }) {'
if anchor not in s:
    sys.exit('native control cannot be synthesized: attach() signature moved')
# Rename rather than early-return: a `return []` at the top of the real body makes GJS
# log "unreachable code after return statement" into the very extension log this harness
# prints, which reads like a defect in the thing under test.
s = s.replace(anchor, 'export async function attach() {\n'
    '    return [];  // harness control: no guard is mounted\n'
    '}\n'
    'async function _control_unused({ ownsSource, log, onError, alive }) {', 1)
open(p, 'w', encoding='utf-8').write(s)
PYCONTROL
    EXT="$PRE"
fi
# The metadata stub must carry settings-schema, or getSettings() inside enable() throws.
SCHEMA=$(sed -n 's/.*"settings-schema"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EXT/metadata.json")
[ -n "$SCHEMA" ] || { echo "metadata.json has no settings-schema" >&2; exit 1; }
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
        // Put every card in the expanded state BEFORE doctoring. collapse() only lands
        // expanded=false for the cards its loop reaches, so an all-false reading is
        // evidence only if true was ever on the table. Measured with the synthesized
        // control: without this line the native side cannot satisfy its own assertion
        // (expanded was false from the start in BOTH modes — a vacuous pair).
        msgs.forEach(m => m.expand(false));
        say('allExpandedBefore', msgs.map(m => m.expanded));
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

        // Second provocation, aimed at the OTHER half of workaround 2. The doctored
        // layout manager above is absorbed by workaround 1 before collapse() ever
        // throws, so the catch branch stays unreached and its state landing untested.
        // Here a message's unexpand is shadowed by an own property that throws for a
        // reason workaround 1 cannot absorb -- which is exactly what the catch exists
        // for. The fade spy proves the branch ran to the end rather than landing only
        // its first three steps. A fresh group, same reason as the close group below.
        const g2 = new ml.NotificationMessageGroup(src);
        await g2.expand();
        const m2 = [...g2._notificationToMessage.values()];
        let fadeCalls = 0;
        const origFade = g2._updateStackedMessagesFade;
        g2._updateStackedMessagesFade = function () {
            fadeCalls++;
            return origFade.call(this);
        };
        m2[0].unexpand = function () {
            throw new TypeError('provoked collapse fault (harness own property)');
        };
        let fallbackThrew = false;
        try {
            await g2.collapse();
        } catch (e) {
            fallbackThrew = true;
            out.fallbackRejection = String(e && e.message || e).slice(0, 100);
        }
        await sleep(400);
        say('fallbackThrewToCaller', fallbackThrew);
        say('fallbackExpandedAfter', g2._expanded);
        say('fallbackCoverShown', g2._cover.visible);
        say('fallbackFadeCalls', fadeCalls);
        say('fallbackHeaderVisible', g2._headerBox.visible);

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
# The two counters that used to sit here ("TypeError … count", "collapse@messageList frame count")
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
    ('the cards entered the collapse expanded',
     bool(c.get('allExpandedBefore')) and all(c.get('allExpandedBefore')),
     'got %r — "unexpanded afterwards" would prove nothing' % (c.get('allExpandedBefore'),)),
]
if expect == 'guarded':
    main = [
        ('collapse did not reach the caller', c.get('collapseThrewToCaller') is False,
         'rejection %r' % d.get('collapseRejection', '')),
        ('group state landed (expanded=false)', c.get('expandedAfter') is False,
         'got %r — half-collapsed is the state that swallows every later click' % c.get('expandedAfter')),
        ('cover re-shown',                 c.get('coverShown') is True, 'got %r' % c.get('coverShown')),
        ('the doctored card was unexpanded too', c.get('brokenMessageExpanded') is False,
         'got %r -- the loop stopped at the doctored entry' % c.get('brokenMessageExpanded')),
        ('every healthy card was unexpanded',
         c.get('healthyExpandedAfter') is not None and
         all(v is False for v in c.get('healthyExpandedAfter')),
         'got %r' % (c.get('healthyExpandedAfter'),)),
        ('closing one card closed one card',
         c.get('notifsBeforeClose') is not None and
         c.get('notifsAfterClose') == c.get('notifsBeforeClose') - 1,
         'before %r after %r' % (c.get('notifsBeforeClose'), c.get('notifsAfterClose'))),
        # The catch branch of workaround 2, provoked directly (see the second
        # provocation in the probe): every step native would have run has to land.
        ('provoked collapse fault was absorbed', c.get('fallbackThrewToCaller') is False,
         'rejection %r' % d.get('fallbackRejection', '')),
        ('catch landed expanded=false',       c.get('fallbackExpandedAfter') is False,
         'got %r' % c.get('fallbackExpandedAfter')),
        ('catch re-showed the cover',         c.get('fallbackCoverShown') is True,
         'got %r' % c.get('fallbackCoverShown')),
        ('catch ran the stacked-fade update', (c.get('fallbackFadeCalls') or 0) >= 1,
         'got %r — the branch landed its first steps only' % c.get('fallbackFadeCalls')),
        ('catch hid the group header',        c.get('fallbackHeaderVisible') is False,
         'got %r — a header left over a collapsed group' % c.get('fallbackHeaderVisible')),
    ]
else:
    main = [
        ('collapse reached the caller (native fault present)',
         c.get('collapseThrewToCaller') is True, 'got %r' % c.get('collapseThrewToCaller')),
        ('group left corrupted (expanded=true)', c.get('expandedAfter') is True,
         'got %r' % c.get('expandedAfter')),
        ('cover never shown',                c.get('coverShown') is False, 'got %r' % c.get('coverShown')),
        ('the loop died at the doctored card', c.get('brokenMessageExpanded') is True,
         'got %r -- the fault was absorbed, so this tree is not the pre-fix one' % c.get('brokenMessageExpanded')),
        ('the cards after it were never reached',
         c.get('healthyExpandedAfter') is not None and
         all(v is True for v in c.get('healthyExpandedAfter')),
         'got %r' % (c.get('healthyExpandedAfter'),)),
        ('native close wiped the whole group',
         c.get('notifsAfterClose') == 0,
         'before %r after %r' % (c.get('notifsBeforeClose'), c.get('notifsAfterClose'))),
        # The rejection must be the KNOWN native fault, not some unrelated throw:
        # 'can't access property "expansion", obj is null' from ease_property on an
        # actor whose layout manager is gone (environment.js:196 raises synchronously).
        ('rejection is the known native TypeError',
         'expansion' in (d.get('collapseRejection') or ''),
         'got %r' % d.get('collapseRejection', '')),
        # Same provocation, no catch: every step after the loop must be provably skipped.
        ('provoked collapse fault reached the caller', c.get('fallbackThrewToCaller') is True,
         'got %r — a catch is mounted, so this tree is not the pre-fix one'
         % c.get('fallbackThrewToCaller')),
        ('fallback rejection is the provoked TypeError',
         'provoked collapse fault' in (d.get('fallbackRejection') or ''),
         'got %r' % d.get('fallbackRejection', '')),
        ('fallback group left corrupted (expanded=true)',
         c.get('fallbackExpandedAfter') is True, 'got %r' % c.get('fallbackExpandedAfter')),
        ('fallback cover never re-shown',
         c.get('fallbackCoverShown') is False, 'got %r' % c.get('fallbackCoverShown')),
        ('fallback skipped the fade update and left the header up',
         (c.get('fallbackFadeCalls') or 0) == 0 and c.get('fallbackHeaderVisible') is True,
         'fade %r header %r' % (c.get('fallbackFadeCalls'), c.get('fallbackHeaderVisible'))),
    ]
bad = 0
for name, ok, extra in pre + main:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  ' + str(extra) if extra and not ok else ''}")
    bad += 0 if ok else 1
print(f"\n{len(pre + main) - bad}/{len(pre + main)} passed  (EXPECT={expect})")
sys.exit(1 if bad else 0)
PY
