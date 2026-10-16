#!/bin/bash
# tests/smoke.sh — the L2 manual checklist (a real session; only you can run it).
#
# Why it is needed: the two L1 harnesses send synthetic notifications with notify-send and can prove
# patch mount/restore and the merge semantics, but not a real sender's behaviour — the last round's
# "groups but the experience is poor" ran green on synthetic notifications. This script auto-checks
# the **machine-checkable** parts first, then prints the items only a human can judge.
#
#   usage: tests/smoke.sh            read-only; changes no config, sends no message, enables/disables nothing
#   convention: the checklist uses no checkbox syntax (committed docs here forbid `- [ ]`, see tests/repo.test.mjs)
set -u
UUID=notification-grouper@local
FAIL=0

line() { printf '%s\n' "---- $*"; }
ok()   { printf '  OK    %s\n' "$*"; }
bad()  { printf '  CHECK %s\n' "$*"; FAIL=$((FAIL+1)); }

line "environment"
GV=$(gnome-shell --version 2>/dev/null)
case "$GV" in
  *" 50."*) ok "$GV" ;;
  *) bad "expected GNOME Shell 50.x, read: ${GV:-(unreadable)}" ;;
esac
if [ -f /usr/lib/gnome-shell/libshell-18.so ]; then
    ok "shell JS lives in libshell-18.so's gresource (re-extract per MAINTENANCE § Upgrade adaptation manual on upgrade)"
else
    bad "/usr/lib/gnome-shell/libshell-18.so is missing — every native line anchor needs re-verification"
fi

line "extension state"
if command -v gnome-extensions >/dev/null 2>&1; then
    INFO=$(gnome-extensions info "$UUID" 2>/dev/null)
    if [ -z "$INFO" ]; then
        bad "gnome-extensions cannot read $UUID (wrong extension dir, or not installed in this session)"
    else
        echo "$INFO" | sed 's/^/        /'
        # Measured on this machine: the enabled state prints "Enabled: Yes" + "State: ACTIVE", not "ENABLED".
        case "$INFO" in
          *"Enabled: Yes"*) ok "enabled (see the State line above)" ;;
          *) bad "not enabled: none of this round's manual items can be verified" ;;
        esac
    fi
else
    bad "no gnome-extensions command"
fi

line "settings surface (real dconf, read-only)"
SCHEMA=$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1])).get('settings-schema',''))" \
    "$HOME/.local/share/gnome-shell/extensions/$UUID/metadata.json" 2>/dev/null)
EXTDIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
if [ -z "$SCHEMA" ]; then
    bad "metadata.json has no settings-schema"
elif [ ! -f "$EXTDIR/schemas/gschemas.compiled" ]; then
    bad "$EXTDIR/schemas/gschemas.compiled is missing — getSettings() throws and the extension cannot start"
else
    ok "schemas/gschemas.compiled is in place ($SCHEMA)"
fi
# Note: the gsettings CLI cannot see an extension's own schema, by design — the extension side builds
# a source on the fly with new_from_directory at extensions/sharedInternals.js:97-105, and the CLI only
# queries the default source. So this reads dconf (the same path, visible to the CLI), and is **read-only**.
if command -v dconf >/dev/null 2>&1; then
    DUMP=$(dconf dump /org/gnome/shell/extensions/notification-grouper/ 2>/dev/null)
    if [ -z "$DUMP" ]; then
        ok "the path is empty in dconf = all four keys are default (10 / on / on / empty list)"
    else
        echo "$DUMP" | sed 's/^/        /'
        bad "these values were written into the **real dconf** (non-default). If you did not set them, reset:"
        bad "  dconf reset -f /org/gnome/shell/extensions/notification-grouper/"
    fi
else
    bad "no dconf command; cannot check the real setting values"
fi

line "logs (this session)"
LOG=$(journalctl --user -b 2>/dev/null | grep -iE 'notification-grouper|messageList' || true)
# These two were added after traps hit this round:
#   - "did this session have an enable line" decides whether the manual items below verify the code
#     currently on disk; disable/enable does not reload ES modules, so an extension whose JS was edited
#     but not followed by a re-login still reads ACTIVE.
#   - "already disposed" is the signature string of a wrong trim timing (max-per-source=1 once
#     triggered it); in the product path it must be treated as a defect, not noise.
if journalctl --user -b 2>/dev/null | grep -q 'notification-grouper] enabled, attached patches'; then
    ok "the extension really was loaded this session (otherwise what follows verifies old code)"
else
    bad "no enable line in this boot's journal: the on-disk code may not be loaded; log out and back in"
fi
# "already disposed" is a **generic string** in GNOME, not ours: this boot measured 5 of them, all
# St.Adjustment / Gjs_ui_layout_UiActor with the stack stopping at GObject.js:710 <- signalTracker.js,
# right at the second the old shell exits and the new one starts — using it as a product verdict would
# be a false accusation. Our defect's signature string is a **notification source of this class** being
# disposed (FdoNotificationDaemonSource), so the verdict must carry the class name.
DISPOSED=$(journalctl --user -b 2>/dev/null | grep -c 'notificationDaemon_FdoNotificationDaemonSource.*already disposed')
if [ "${DISPOSED:-0}" -eq 0 ]; then
    ok "no line showing a notification source disposed (trim timing is correct)"
else
    bad "$DISPOSED lines of FdoNotificationDaemonSource already disposed: the trim emptied the merged source (native self-destructs on an empty source)"
fi
OTHER=$(journalctl --user -b 2>/dev/null | grep 'already disposed' | grep -vc 'notificationDaemon_FdoNotificationDaemonSource')
[ "${OTHER:-0}" -eq 0 ] || echo "  (plus $OTHER disposed lines of other classes — shell noise, not judged)"
if [ -z "$LOG" ]; then
    ok "no notification-grouper / messageList lines"
else
    echo "$LOG" | tail -20 | sed 's/^/        /'
    if echo "$LOG" | grep -qiE 'pending-(appname-)?mismatch'; then
        bad "a pending-*-mismatch line appeared: the _pending synchronous hand-off assumption broke, please report (see AGENTS.md)"
    fi
    if echo "$LOG" | grep -qi 'degraded'; then
        bad "a degraded line appeared: upstream renamed a method/module we depend on"
    fi
    if echo "$LOG" | grep -qiE 'JS ERROR.*(messageList|unexpand|expansion)'; then
        bad "the collapse defect still reproduces (the guard did not stop it) — check MAINTENANCE § Upgrade adaptation manual step 4"
    fi
fi

cat <<'TXT'

---- Items only your eyes can verify (do each in turn and report the result back in the session; the script does not guess)

  1. Real senders, not synthetic notify-send:
     - have a CLI hook / agent completion notification send one (that class of app_name is a bare `notify-send` call)
     - have a tool with an explicit `--app-name` send 3 in a row from different processes
     - send one each via systemd (`systemd-notify --user` or a unit's status notification)
     Expected: the three sharing one declared name merge into one stack header; the systemd one goes by its own identity.

  2. Click semantics (these three are the experience problems reported historically):
     - in the expanded state, click a card with nowhere to jump: only that one disappears, the rest stay, the calendar is not closed
     - a collapsed multi-card merged group: the first click only expands, the second acts (native behaviour, see README)
     - in the collapsed state, click one card's ×: only that one closes, not the whole group

  3. Freeze regression: expand/collapse one merged group ~20 times, letting a few expire naturally along the way.
     Expected: the list always responds; no `TypeError … expansion` and no messageList JS ERROR in the journal.

  0. Why these must be seen by your eyes: a real session has org.gnome.Shell.Eval off (needs unsafe-mode), so the
     agent cannot count sources live and can only verify up to "did the settings chain notify the shell" (the journal
     has grouping off/on lines); "merge into one stack / trim / the exception list not merging" needs the tray.

  4. The prefs page (gnome-extensions prefs notification-grouper@local) — the L0.5 introspection gate can only prove
     the members exist; rendering and interaction can only be seen here:
     - two switch rows, one 1..10 number row, one expandable exception-name list row all **render**
     - toggling a switch needs no re-enabling of the extension: send a notification immediately and the grouping on/off difference shows
     - put a really-existing sender name in the exception list and it should leave the merged group (note case/.desktop insensitivity)
     - "Restore every default" resets the four keys at once
     - set cards kept per stack to **1**: the merged stack should keep only the newest card and the journal must show no already disposed
       (this is the defect point fixed this round; before v9 it stepped onto a destroyed source)
     - look once under a dark and a light theme; your own controls must not mix into the native style

  5. Residue after disabling: after turning the extension off
     - the merged stack should disappear (intentional, see README § Known limitations)
     - the journal line `disabled, restored patches: …` should agree with "sending again returns to one stack per process"
     - enable once more and both grouping and the workarounds come back (no logout needed)

  6. Idle cost: after logging in, leave it for 30 minutes, comparing
     `ps -o rss=,etime=,pcpu= -C gnome-shell` in the on and off states. This is a **trend**, not a verdict;
     the headless RSS number cannot measure real power draw (MAINTENANCE § Fixed measurement methods for power draw and leaks).

TXT

line "conclusion"
if [ "$FAIL" -eq 0 ]; then
    echo "  Everything machine-checkable is OK. The 6 manual groups above still need you to report each in turn."
else
    echo "  $FAIL machine-checkable item(s) need your eyes — they are not necessarily bugs, but none may be treated as verified."
fi
exit 0
