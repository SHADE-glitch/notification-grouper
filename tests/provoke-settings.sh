#!/bin/bash
# tests/provoke-settings.sh — proves that the gates on "user-visible behaviour" really hang off
# behaviour rather than being permanently green. It covers the four settings-surface keys, the trim
# timing, and the reason handed to the sender: any assertion of the "the implementation idles and it
# still reads green" kind should have a matching mutation here.
#
# Method: copy the whole tree to /tmp, change one settings read point **into a constant** in the copy
# (i.e. "the setting is ignored"), run the same tests/headless-verify.sh, and require the **matching
# assertion to go red**. Only that one assertion is judged; the others do not take part. An assertion
# that reads PASS whether or not the implementation took effect has no reason to exist — this script
# exists to expose exactly that. It never touches the working tree.
#
#   usage: tests/provoke-settings.sh          (8 headless rounds, one per entry in CASES)
#   exit:  0 every mutation produced the expected red; 1 a mutation did not go red, or a literal is stale
#
# Fields are separated by TAB, not a pipe: both assertion names and replacement strings may contain a pipe.
#
# Traps already paid for:
#   - A literal must match **exactly once**. `this._x = s.get_...(...)` appears once in the changed::
#     handler and once in _readSettings(), at different indentation (16 spaces vs 8); counting with the
#     8-space version hits 2 times (it is a substring of the 16-space line), so the literal here carries
#     the full indentation. A hit count other than 1 reports STALE instead of continuing silently.
#   - A mutation must hit only the "the setting takes effect" path. Changing the initial read while
#     leaving changed:: untouched still reads green (the harness sets after enable), so both cases
#     change the changed:: handler line.
#   - The replacement must still be valid JS, or the red is a false red caused by a syntax error
#     (guarded with node --check).
#   - A mutation must hit the **path that really takes effect**. Changing `if (!this._uiGuardsEnabled)`
#     to `if (false)` is an **equivalent mutant** that does not go red: turning the switch off sends
#     `_mountUiGuards()` down the attach branch, and attach()'s first statement is detach(), so the
#     workarounds are removed anyway — staying green is the correct result, not a false green. So the
#     workaround toggle uses two single-spot mutations (the line that removes the workarounds / the
#     line that reads the setting) instead of changing the outer condition.
#   - Shell logs contain binary bytes; grep without -a only replies "binary file matches".
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${TMPDIR:-/tmp}/ng-provoke
PASS=0; FAILED=0

# Fields: id <TAB> literal <TAB> replacement <TAB> assertion name expected to go red
CASES=(
"cap-ignored	              this._maxPerSource = s.get_int('max-per-source');	              this._maxPerSource = 10;	max-per-source=3 trims to 3"
"grouping-ignored	              this._groupingEnabled = s.get_boolean('grouping-enabled');	              this._groupingEnabled = true;	grouping off stops merging"
"isolate-ignored	        this._isolated = normalizeIsolate(s.get_strv('isolate-apps'));	        this._isolated = new Set();	isolate-apps keeps that app apart"
"guards-off-detach-removed	            UiWorkarounds.detach();	            /* provocation: not detached */;	ui-guards off detaches them"
"ui-guards-ignored	                this._uiGuardsEnabled = s.get_boolean('ui-guards');	                this._uiGuardsEnabled = true;	ui-guards off detaches them"
"settings-not-disconnected	        for (const id of this._settingsHids)	        for (const id of [])	disable disconnects settings"
"post-push-trim-removed	                const served = self._pending && self._pending.servedSource;	                const served = null;	max-per-source=3 trims to 3"
"evict-reason-dismissed	            oldest.destroy(NotificationDestroyedReason.EXPIRED);	            oldest.destroy(NotificationDestroyedReason.DISMISSED);	FDO sees EXPIRED for evicted cards"
)

for entry in "${CASES[@]}"; do
    id=${entry%%	*}
    rest=${entry#*	}
    from=${rest%%	*}
    rest2=${rest#*	}
    to=${rest2%%	*}
    expect=${rest2#*	}

    D="$WORK/$id"
    /bin/rm -rf "$D"; mkdir -p "$D"
    tar -C "$ROOT" --exclude=.git --exclude=reports -cf - . | tar -C "$D" -xf -

    # Literal replacement uses python, not sed: the strings contain quotes, dots and parentheses,
    # which sed would treat as metacharacters. Indentation is part of the literal, and the replacement
    # carries the same indentation, so the line start does not collapse after replacement.
    if ! python3 - "$D/extension.js" "$from" "$to" "$id" <<'PY'
import sys
p, frm, to, id_ = sys.argv[1:5]
s = open(p, encoding='utf-8').read()
n = s.count(frm)
if n != 1:
    print(f"STALE {id_}: pattern occurs {n} times, expected exactly 1")
    sys.exit(2)
open(p, 'w', encoding='utf-8').write(s.replace(frm, to, 1))
PY
    then
        echo "STALE     $id — the literal no longer matches extension.js; fix this script"
        FAILED=$((FAILED+1)); continue
    fi
    node --check "$D/extension.js" >/dev/null 2>&1 || {
        echo "BROKEN    $id — mutation produced unparsable JS"; FAILED=$((FAILED+1)); continue; }

    OUT="$WORK/$id.log"
    bash "$ROOT/tests/headless-verify.sh" "$D" >"$OUT" 2>&1
    rc=$?
    if grep -aqF "FAIL  $expect" "$OUT"; then
        echo "PROVEN    $id -> '$expect' went red (harness exit $rc)"
        PASS=$((PASS+1))
    else
        echo "NOT-PROVEN $id -> '$expect' did NOT go red (harness exit $rc):"
        grep -aE "^  (PASS|FAIL)  $expect" "$OUT" | sed 's/^/           /'
        FAILED=$((FAILED+1))
    fi
done

echo
echo "$PASS proven, $FAILED not proven (${#CASES[@]} mutations)"
/bin/rm -rf "$WORK"
[ "$FAILED" -eq 0 ]
