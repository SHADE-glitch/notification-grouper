#!/bin/bash
# tests/smoke.sh — L2 手验清单（真实会话，只有你能跑）。
#
# 为什么需要它：L1 的两个 harness 用 notify-send 合成通知，能证明补丁挂载/还原和合并语义，
# 但证明不了真实发送方的行为——上一轮"能分组但体验差"就是在合成通知上跑绿的。
# 这个脚本先自动核对**机器能核对的**部分，再把只剩人手能判断的项打印出来。
#
#   usage: tests/smoke.sh            只读；不改任何配置、不发消息、不启用/禁用扩展
#   约定：清单不用复选框语法（本仓库入库文档一律禁 `- [ ]`，见 tests/repo.test.mjs）
set -u
UUID=notification-grouper@local
FAIL=0

line() { printf '%s\n' "---- $*"; }
ok()   { printf '  OK    %s\n' "$*"; }
bad()  { printf '  CHECK %s\n' "$*"; FAIL=$((FAIL+1)); }

line "环境"
GV=$(gnome-shell --version 2>/dev/null)
case "$GV" in
  *" 50."*) ok "$GV" ;;
  *) bad "期望 GNOME Shell 50.x，读到：${GV:-（读不到）}" ;;
esac
if [ -f /usr/lib/gnome-shell/libshell-18.so ]; then
    ok "shell JS 在 libshell-18.so 的 gresource 里（升级时按 MAINTENANCE § 升级适配手册 重取）"
else
    bad "/usr/lib/gnome-shell/libshell-18.so 不存在——原生行号锚点全部需要重验"
fi

line "扩展状态"
if command -v gnome-extensions >/dev/null 2>&1; then
    INFO=$(gnome-extensions info "$UUID" 2>/dev/null)
    if [ -z "$INFO" ]; then
        bad "gnome-extensions 读不到 $UUID（扩展目录不对，或没装进当前会话）"
    else
        echo "$INFO" | sed 's/^/        /'
        # 本机实测：启用态打印的是 "Enabled: Yes" + "State: ACTIVE"，不是 "ENABLED"。
        case "$INFO" in
          *"Enabled: Yes"*) ok "已启用（State 见上一行）" ;;
          *) bad "未启用：本轮所有手工项都无法验证" ;;
        esac
    fi
else
    bad "没有 gnome-extensions 命令"
fi

line "设置面（真实 dconf，只读）"
SCHEMA=$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1])).get('settings-schema',''))" \
    "$HOME/.local/share/gnome-shell/extensions/$UUID/metadata.json" 2>/dev/null)
EXTDIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
if [ -z "$SCHEMA" ]; then
    bad "metadata.json 没有 settings-schema"
elif [ ! -f "$EXTDIR/schemas/gschemas.compiled" ]; then
    bad "$EXTDIR/schemas/gschemas.compiled 不存在——getSettings() 会抛，扩展起不来"
else
    ok "schemas/gschemas.compiled 就位（$SCHEMA）"
fi
# 注意：gsettings CLI 看不见扩展自带的 schema，这是设计如此——扩展侧是
# extensions/sharedInternals.js:97-105 用 new_from_directory 现造一个 source，
# CLI 只查默认 source。所以这里读 dconf（同一个 path，CLI 可见），并且**只读不写**。
if command -v dconf >/dev/null 2>&1; then
    DUMP=$(dconf dump /org/gnome/shell/extensions/notification-grouper/ 2>/dev/null)
    if [ -z "$DUMP" ]; then
        ok "dconf 里该路径为空 = 四个键都是默认值（10 / 开 / 开 / 空表）"
    else
        echo "$DUMP" | sed 's/^/        /'
        bad "这些值被写进了**真实 dconf**（非默认）。若不是你自己拨的，回默认："
        bad "  dconf reset -f /org/gnome/shell/extensions/notification-grouper/"
    fi
else
    bad "没有 dconf 命令，无法核对真实设置值"
fi

line "日志（本轮会话）"
LOG=$(journalctl --user -b 2>/dev/null | grep -iE 'notification-grouper|messageList' || true)
# 这两条是本轮踩过坑之后加的：
#   - 「本轮有没有 enable 行」决定下面手工项验的是不是当前磁盘上的代码；
#     disable/enable 不重载 ES 模块，改了 JS 却没重新登录时，扩展照样 ACTIVE。
#   - 「already disposed」是削位时机错的特征串（max-per-source=1 曾经触发），
#     产品路径里出现它就该当成缺陷，不是噪声。
if journalctl --user -b 2>/dev/null | grep -q 'notification-grouper] enabled, attached patches'; then
    ok "本轮会话里扩展确实被加载过（否则下面验的还是旧代码）"
else
    bad "本轮 journal 没有 enable 行：磁盘代码可能没被加载，需要登出再登录"
fi
# 「already disposed」是 GNOME 里的**通用串**，不是我们的特征串：本 boot 实测有 5 条，
# 全是 St.Adjustment / Gjs_ui_layout_UiActor，栈停在 GObject.js:710 ← signalTracker.js，
# 时间就在旧 shell 退出、新 shell 起来那一秒——拿它当产品判据会诬告。
# 我们那个缺陷的特征串是**通知源这个类**被 dispose（FdoNotificationDaemonSource），
# 判据必须带上类名。
DISPOSED=$(journalctl --user -b 2>/dev/null | grep -c 'notificationDaemon_FdoNotificationDaemonSource.*already disposed')
if [ "${DISPOSED:-0}" -eq 0 ]; then
    ok "没有通知源被 dispose 的行（削位时机正确）"
else
    bad "$DISPOSED 条 FdoNotificationDaemonSource already disposed：削位把合并源清空过（原生见空源自毁）"
fi
OTHER=$(journalctl --user -b 2>/dev/null | grep 'already disposed' | grep -vc 'notificationDaemon_FdoNotificationDaemonSource')
[ "${OTHER:-0}" -eq 0 ] || echo "  （另有 $OTHER 条别的类的 disposed 行，属 shell 自身噪声，不参与判定）"
if [ -z "$LOG" ]; then
    ok "没有 notification-grouper / messageList 相关行"
else
    echo "$LOG" | tail -20 | sed 's/^/        /'
    if echo "$LOG" | grep -qiE 'pending-(appname-)?mismatch'; then
        bad "出现 pending-*-mismatch：_pending 的同步交接假设被打破，请上报（见 AGENTS.md）"
    fi
    if echo "$LOG" | grep -qi 'degraded'; then
        bad "出现 degraded：上游改了被依赖的方法/模块名"
    fi
    if echo "$LOG" | grep -qiE 'JS ERROR.*(messageList|unexpand|expansion)'; then
        bad "折叠缺陷仍然复现（兜底没拦住）——按 MAINTENANCE § 升级适配手册 第 4 步查"
    fi
fi

cat <<'TXT'

---- 只有你的手能验的项（逐条做，做完在会话里回报结果；脚本不猜）

  1. 真实发送方，不用 notify-send 合成：
     - 让 CLI hook / agent 完成通知发一条（那一类 app_name 是 `notify-send` 的裸调用）
     - 让带显式 `--app-name` 的工具连发 3 条不同进程
     - 用 systemd 发的通知（`systemd-notify --user` 或 unit 的状态通知）各来一条
     预期：同一声明名的三条合并成一个栈头；systemd 的那条按它自己的身份走。

  2. 点击语义（这三条就是历史上报过的体验问题）：
     - 展开态里点一张无处可跳的卡：只有那一张消失，其余保留，日历不被关掉
     - 折叠态的多卡合并组：第一下只展开，第二下才动作（原生行为，见 README）
     - 折叠态里点某张卡的 ×：只关那张，不关整组

  3. 卡死回归：把一个合并组反复展开/折叠 ~20 次，中途让它自然过期几张。
     预期：列表始终有反应；journal 无 `TypeError … expansion`、无 messageList JS ERROR。

  0. 为什么这几条必须由你眼睛看：真会话的 org.gnome.Shell.Eval 是关的（要 unsafe-mode），
     代理在实况里数不到源数量，只能验到「设置链路有没有通知到 shell」这一层（journal 有
     grouping off/on 这类行）；「合并成一个栈 / 削位 / 例外名单不合并」必须看托盘。

  4. 设置页（gnome-extensions prefs notification-grouper@local）——L0.5 的内省门只能证明
     成员存在，渲染与交互只能在这里看：
     - 两个开关行、一个 1..10 的数字行、一个可展开的例外名列表行都**渲染出来**了
     - 拨动开关不需要重新启用扩展：立刻发通知即可看到分组开/关的差别
     - 例外表里填一个真实存在的发送方名字，它就该从合并组里退出去（注意大小写/.desktop 不敏感）
     - "恢复默认"把四个键一次还原
     - 每堆保留卡片数拨到 **1**：合并栈应当只留最新一张且 journal 无 already disposed
       （这是本轮修掉的缺陷点，v9 之前会踩到已销毁的源）
     - 深色与浅色主题下都看一眼，不要有你自己的控件混进原生样式

  5. 禁用后残留：关掉扩展后
     - 合并栈应当消失（这是有意的，见 README § Known limitations）
     - journal 里那行 `disabled, restored patches: …` 与"再发通知回到每进程一栈"一致
     - 再启用一次，分组与兜底都回来（不需要注销）

  6. 空闲代价：登录后放着 30 分钟不动，比较开/关两种状态的
     `ps -o rss=,etime=,pcpu= -C gnome-shell`。这是**趋势**，不是判据；
     headless 的 RSS 数字测不到真实功耗（MAINTENANCE § 功耗与泄漏的固定度量方法）。

TXT

line "结论"
if [ "$FAIL" -eq 0 ]; then
    echo "  机器可核对的部分全部 OK。上面 6 组手工项仍需你逐条回报。"
else
    echo "  机器可核对的部分有 $FAIL 项需要你看过——它们未必是 bug，但都不能当成已验证。"
fi
exit 0
