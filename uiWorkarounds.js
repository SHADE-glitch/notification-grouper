// uiWorkarounds.js — GNOME 50 原生 messageList 缺陷的临时兜底（三处原型补丁）。
//
// 定位：这不是分组功能，而是替上游缺陷擦屁股，所以它必须是一个**可撤销的单元**。
// 上游修复后按下面清单删除（实测涉及 9 个文件；"rm 一个文件就行"是假的）：
//   1. rm uiWorkarounds.js
//   2. rm tests/headless-ui-guard.sh      —— 这台激发机只为兜底存在
//   3. package.json                       —— 去掉 verify:ui-guard 脚本
//   4. extension.js                       —— 顶部注释、import、disable() 的 detach() 调用
//      与日志里的 guards: 一段、_attach() 末尾的 attach({...})
//   5. groupEngine.js                     —— REQUIRED_UI_GUARDS 与 checkUiGuardPoints
//   6. tests/test-groupEngine.mjs         —— 那 2 个 checkUiGuardPoints 用例及其 import
//   7. tests/repo.test.mjs                —— HOME.guard、REQUIRED_UI_GUARDS 两处、
//      "兜底不得漏进 extension.js" 那条断言
//   8. tests/check-log.mjs                —— CODE_PATHS 去掉 'uiWorkarounds.js'
//   9. tests/headless-verify.sh           —— Uw import、guardsMountedBeforeJudging、
//      guardsRestoredToPristine、disable log matches reality 及 python 侧对应条目
// 删完后 CHANGELOG 记一条 revert，引用引入兜底的 D-id。
// 与分组层（extension.js）和纯函数层（groupEngine.js）都独立降级：拿不到
// messageList.js 只丢这三处兜底，分组照常。
//
// 状态是模块级的，不是实例级的：原型补丁本来就是进程全局的，一个 shell 里
// 只会有一份扩展代码，模块态与"当前是否已挂"天然同构。_origUi 非 null 仍是
// 唯一的"已挂"判据（与 daemon 层的 _orig 同一模式）。

import { checkUiGuardPoints, REQUIRED_UI_GUARDS } from './groupEngine.js';

let _ownsSource = null;
let _onError = null;
let _origUi = null;
let _applied = [];

/**
 * 挂三处兜底。必须 await（动态 import），但调用方（enable 路径）**不许** await 它：
 * enable() 保持同步是 _pending 交接假设的一部分。
 *
 * @param {object} deps
 * @param {(src: object) => boolean} deps.ownsSource 该 Source 是否本扩展自建
 *        （传谓词不传 Set：enable() 若重建 Set，捕获旧 Set 的兜底会无声失效）
 * @param {(msg: string) => void} deps.log 日志出口（保持"每事件一行、永不记 body"）
 * @param {(e: any, msg: string) => void} deps.onError 原生缺陷被触发时的栈出口
 * @param {() => boolean} deps.alive 扩展当前是否仍启用（await 之后必须复查）
 * @returns {Promise<string[]>} 实际挂上的兜底名
 */
export async function attach({ ownsSource, log, onError, alive }) {
    detach();                      // 幂等：先剥掉可能残留的上一层

    let mod = null;
    let detail = '';
    try {
        // 动态 import：上游一旦改名/删文件，静态 import 会让整个扩展进 ERROR 态、
        // 连分组都不再工作，而那比"没有兜底"糟得多。
        mod = await import('resource:///org/gnome/shell/ui/messageList.js');
    } catch (e) {
        detail = e && e.message ? e.message : String(e);
    }

    // 动态导入期间可能已经 disable：此时挂上去就再也无人还原了。
    if (!alive())
        return [];

    // detach 必须在 await *之后*、捕获之前。放在 await 之前等于没放：两次 enable
    // 的这段会在同一轮微任务里先后续上，后者把前者的包裹层当作"原生方法"存下来，
    // 原型于是叠层，而 disable() 只能剥掉最外一层——剩下的一层永久存活，
    // 还会让 disable 日志报出"已还原三处兜底"的假结果。
    detach();

    const Message = mod ? mod.Message ?? null : null;
    const Group = mod ? mod.NotificationMessageGroup ?? null : null;
    const NotificationMessage = mod ? mod.NotificationMessage ?? null : null;
    const check = checkUiGuardPoints({
        moduleLoaded: !!mod,
        detail,
        hasMessage: !!Message,
        hasGroup: !!Group,
        hasNotifMessage: !!NotificationMessage,
        hasUnexpand: !!(Message && typeof Message.prototype.unexpand === 'function'),
        hasCollapse: !!(Group && typeof Group.prototype.collapse === 'function'),
        hasNotifClose: !!(NotificationMessage &&
            typeof NotificationMessage.prototype.close === 'function'),
    });
    if (!check.apply) {
        _applied = [];
        log(`UI guards degraded: ${check.warnings.join('; ')}`);
        return _applied;
    }

    _ownsSource = ownsSource;
    _onError = onError;
    _origUi = {
        Message,
        Group,
        NotificationMessage,
        unexpand: Message.prototype.unexpand,
        collapse: Group.prototype.collapse,
        notifClose: NotificationMessage.prototype.close,
    };

    // 兜底 1 —— Message.unexpand(animate)（messageList.js:644）：
    // actor 已从容器摘下时没有 layout manager，原生 :646 的
    // ease_property('@layout.expansion') 需要 layout manager，取不到即同步抛出
    // （environment.js:196 的 _easeAnimatableProperty 是普通函数，.catch() 抓不到）。
    // 无 layout manager 时把终态直接落位并返回，让 collapse() 的 forEach 能跑完
    // 剩下的消息——否则一条脏消息会连带让它后面的消息全部留在展开态。
    // 对健康 actor 一律原样转发，绝不代替原生做主。
    const origUnexpand = _origUi.unexpand;
    Message.prototype.unexpand = function (animate) {
        let hasLayout = false;
        try {
            hasLayout = !!this._bodyBin && this._bodyBin.get_layout_manager() !== null;
        } catch {
            hasLayout = false;
        }
        if (!hasLayout) {
            try {
                this._actionBin?.hide();
                this.expanded = false;
            } catch {
                /* actor already disposed */
            }
            return;
        }
        return origUnexpand.call(this, animate);
    };

    // 兜底 2 —— NotificationMessageGroup.collapse()（messageList.js:988 async）：
    // forEach :992 一旦抛出，:998 的 _expanded=false 与 :1000 的 _cover.show() 永远
    // 轮不到，分组永久停在半折叠态，之后每次点击都被原生 :1114-1119 的
    // if (!this.expanded) 吞掉——用户看到的"通知栏卡住、点什么都没反应"。
    // 这里捕获抛出并把状态落位，不改语义。
    const origCollapse = _origUi.collapse;
    Group.prototype.collapse = async function () {
        try {
            return await origCollapse.call(this);
        } catch (e) {
            _onError(e, 'NotificationMessageGroup.collapse() threw');
            try {
                this._expanded = false;
                this.notify('expanded');
                this._cover?.show();
            } catch {
                /* group already disposed */
            }
        }
    };

    // 兜底 3 —— NotificationMessage.close()：折叠组里点一张卡的 ×，原生
    // messageList.js:1107-1112 先 signal_stop_emission 再 group.close()，把"关一张"
    // 升级成"关整组"。原生一个源≈一张卡，代价看不见；合并让一组变 N 张，代价被放大。
    // 只在**本扩展自建的源**、且组处于折叠态时，改为只关这一张：直接跑 close 信号的
    // 默认处理器 on_close()（GJS 按 on_<signal> 自动接线，实测确认），跳过派发，
    // 组处理器就不会把这次 close 升级成整组关闭。原生源、展开态、单卡组一律走原生
    // 路径（单卡组按 :952 的 getter 视为已展开）。判定失败就落回原生，绝不吞掉一次关闭。
    const origNotifClose = _origUi.notifClose;
    NotificationMessage.prototype.close = function () {
        try {
            const item = this.get_parent();
            const group = item ? item.get_parent() : null;
            if (group instanceof Group && !group.expanded &&
                _ownsSource(group.source) &&
                typeof this.on_close === 'function') {
                this.on_close();
                return;
            }
        } catch {
            /* 判定失败就落回原生 */
        }
        return origNotifClose.call(this);
    };

    _applied = check.guards;
    return _applied;
}

/**
 * 还原三处兜底。可安全重复调用；_origUi 非 null 即"当前已挂"的唯一判据。
 * @returns {string[]} 本次真正还原的兜底名（未挂过时为空数组）
 */
export function detach() {
    const o = _origUi;
    if (!o)
        return [];
    try {
        o.Message.prototype.unexpand = o.unexpand;
    } catch {
        /* best effort */
    }
    try {
        o.Group.prototype.collapse = o.collapse;
    } catch {
        /* best effort */
    }
    try {
        o.NotificationMessage.prototype.close = o.notifClose;
    } catch {
        /* best effort */
    }
    _origUi = null;
    _ownsSource = null;
    _applied = [];
    return [...REQUIRED_UI_GUARDS];
}

/** 当前挂着的兜底名（attach 完成后非空；detach/降级后为空）。 */
export function applied() {
    return [..._applied];
}
