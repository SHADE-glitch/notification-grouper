#!/bin/bash
# tests/provoke-settings.sh — 证明"设置项断言"真的接着行为，而不是恒绿。
#
# 做法：把整棵树复制到 /tmp，在副本里把某个设置的读取点**改成常量**（即"设置被
# 忽略"），跑同一个 tests/headless-verify.sh，要求**对应那条断言变红**。判定只看
# 那一条，其它断言不参与。一条断言若无论实现有没有生效都读作 PASS，它就没有存在
# 价值——这个脚本专门用来暴露那种情况。绝不改动工作树。
#
#   usage: tests/provoke-settings.sh          （5 轮 headless，约 4 分钟）
#   exit:  0 每个变异都打出了预期的红；1 有变异没被打红，或字面串已过时
#
# 字段分隔用 TAB，不用竖线：断言名和替换串里都可能出现竖线。
#
# 已踩过的坑：
#   - 字面串必须**恰好命中一次**。`this._x = s.get_...(...)` 在 changed:: 处理器和
#     _readSettings() 里各写了一遍，缩进不同（16 空格 vs 8 空格）；拿 8 空格版本去
#     数会命中 2 次（它是 16 空格那行的子串），所以这里用带完整缩进的字面串。命中
#     次数不为 1 直接报 STALE，不静默继续。
#   - 变异必须只打"设置生效"这一条路径。把 initial read 改掉却留着 changed:: 不改
#     也照样是绿的（harness 是 enable 之后才 set 的），所以两个 case 都改 changed::
#     处理器那一行。
#   - 替换后必须还是合法 JS，否则红是语法错误造成的假红（用 node --check 把关）。
#   - 变异必须打到**真实生效的那条路径**。把 `if (!this._uiGuardsEnabled)` 改成
#     `if (false)` 是一个**等价变异**，打不红：关开关时 `_mountUiGuards()` 走 attach 分支，
#     而 attach() 第一句就是 detach()，兜底照样被撤——断言仍然绿是正确结果，不是假绿。
#     所以兜底开关用两个各打一处的变异（撤兜底那一句 / 读设置那一句），而不是改外层条件。
#   - shell 日志含二进制字节，grep 不加 -a 会只回 "binary file matches"。
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${TMPDIR:-/tmp}/ng-provoke
PASS=0; FAILED=0

# 字段：id <TAB> 字面串 <TAB> 替换成 <TAB> 期望变红的断言名
CASES=(
"cap-ignored	              this._maxPerSource = s.get_int('max-per-source');	              this._maxPerSource = 10;	max-per-source=3 trims to 3"
"grouping-ignored	              this._groupingEnabled = s.get_boolean('grouping-enabled');	              this._groupingEnabled = true;	grouping off stops merging"
"isolate-ignored	        this._isolated = normalizeIsolate(s.get_strv('isolate-apps'));	        this._isolated = new Set();	isolate-apps keeps that app apart"
"guards-off-detach-removed	            UiWorkarounds.detach();	            /* provocation: not detached */;	ui-guards off detaches them"
"ui-guards-ignored	                this._uiGuardsEnabled = s.get_boolean('ui-guards');	                this._uiGuardsEnabled = true;	ui-guards off detaches them"
"settings-not-disconnected	        for (const id of this._settingsHids)	        for (const id of [])	disable disconnects settings"
"post-push-trim-removed	                const served = self._pending && self._pending.servedSource;	                const served = null;	max-per-source=3 trims to 3"
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

    # 字面替换用 python，不用 sed：串里有引号、点、括号，sed 会当元字符。
    # 缩进属于字面串的一部分，替换串同样带缩进，所以替换后行首不塌。
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
