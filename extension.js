// notification-grouper@local — GNOME 50 通用通知分组（零配置，只按发出应用分组）。
//
// 机制：挂接 FDO 实例的两个方法 + 一处"只在自建源上"的行为覆盖
// （自降级：前两个缺任一 -> 完全惰性，不半挂载；后两者独立降级）：
//  1. NotifyAsync 包裹层：入口读 hints（deepUnpack），computeGroup()（纯函数，
//     见 groupEngine.js）得 {groupKey, mergeable}，暂存 _pending（携带 senderPid
//     与原始 app_name 两个一致性校验位）。50.1 源码核对：NotifyAsync 为同步方法
//     （notificationDaemon.js），从入口到 Source 查找之间无 await，整文件无
//     async——try/finally 暂存安全（JS 单线程 + D-Bus 同步派发，无重入）。
//  2. _getSourceForPidAndName 包裹层：消费 _pending。mergeable 时按 groupKey
//     复用/新建共享 Source；mergeable=false（app_name 为空）一律原生直通。
//     已解析到 source.app 的走 _getSourceForApp，原生已按 App 成栈，本扩展不碰；
//     Gtk 路径（GtkNotificationDaemon*）是另一个独立对象与类，不引用不 patch。
//  3. 新建共享 Source 时覆盖它的 open()：原生 open() 会 destroyNonResident-
//     Notifications() 把整个源清空，原生一个源≈一张卡，合并后却是一组——点一张
//     卡就清整组。覆盖后只保留 openApp()（本源 app 恒 null，实为 no-op），被点的
//     那张仍由 Notification.activate() 自行销毁。原生源不碰、disable 时还原。
//
// 覆盖范围：所有解析不到 App 的来源（_getSourceForPidAndName 路径）——有 app_name
// 但无 App 的来源，原生每次新 pid 建新 Source，本扩展按归一化 app_name 合并到
// 同一共享 Source，实现"按发出应用分组"。
//
// 界面/图标/上限全部走原生：不覆盖 _appName/_appIcon，不注入按钮。唯一的界面行为
// 差异是上面第 3 点（自建源的 open() 不再批量清空）与下面的 close 兜底，二者都只
// 作用于本扩展自建的合并源。disable 时还原 daemon 两处补丁、自建源的 open() 覆盖、
// 两处 UI 方法兜底、断开每源信号、清空缓存。
//
// 日志：默认安静——enable/attach/disable 各一行；无 per-notify 日志，永不记 body。
//
// UI 兜底（与分组无关，独立降级）：GNOME 50 原生 messageList.js 有两处会把 N 卡的
// 合并组坑到的行为，取不到 messageList.js 只丢兜底、分组照常，上游修复后本段可整块删除：
//   - Message.unexpand() + NotificationMessageGroup.collapse()：原生缺陷——"折叠分组
//     时踩到已销毁 actor"一旦抛出，分组永久留在半折叠态，之后每次点击都被 native 的
//     if (!this.expanded) 吞掉（用户看到的"通知栏卡住、点什么都没反应"）。前者 actor 无
//     layout manager 时落终态返回保证 forEach 跑完，后者捕获抛出并强制 _expanded/cover 落位。
//   - NotificationMessage.close()：折叠组的每消息 close 处理会把"关一张"升级成"关整组"
//     （messageList.js:1107），原生一个源≈一张卡时看不见，合并后代价放大；这里仅对本扩展
//     自建源 + 折叠态，改为只关这一张（直接跑 close 的默认处理器 on_close）。

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { computeGroup, checkAttachPoints, checkUiGuardPoints } from './groupEngine.js';

const LOG_PREFIX = '[notification-grouper]';

export default class NotificationGrouperExtension extends Extension {
    _enabled = false;
    /** groupKey -> {source, hid, origOpen, patchedOpen}（共享 Source 缓存，destroy 自清） */
    _shared = new Map();
    /** 本扩展创建的合并 Source 集合：UI 层据此判断"这张卡属于本扩展"（见 _attachUiGuards） */
    _ownSources = new Set();
    /** 当前同步调用中的 computeGroup 结果与校验上下文（见文件头设计 1） */
    _pending = null;
    _orig = null;
    _appliedPatches = [];
    /** UI 兜底的原始方法（仅当成功挂上时非 null，兼作"当前是否已挂"判据） */
    _origUi = null;
    _appliedGuards = [];
    _warned = new Set();

    enable() {
        this._enabled = true;
        this._shared = new Map();
        this._ownSources = new Set();
        this._pending = null;
        this._appliedPatches = [];
        this._appliedGuards = [];
        this._origUi = null;
        this._warned = new Set();
        // Main.notificationDaemon 在 main.js 早于 ExtensionManager 创建
        // （notificationDaemon 构造器内同步建 _fdoNotificationDaemon），
        // 故 enable 时已就绪，无需异步导入。
        try {
            this._attach();
        } catch (e) {
            logError(e, `${LOG_PREFIX} attach failed, staying inert`);
        }
    }

    disable() {
        this._enabled = false;
        this._detachPatches();
        this._detachUiGuards();
        for (const [, rec] of this._shared) {
            try {
                rec.source.disconnect(rec.hid);
            } catch {
                /* already gone */
            }
            // 还原合并源上的 open() 覆盖（原生源从未被覆盖过）。
            try {
                if (rec.patchedOpen && rec.source.open === rec.patchedOpen)
                    rec.source.open = rec.origOpen;
            } catch {
                /* source already disposed */
            }
        }
        this._shared.clear();
        this._ownSources.clear();
        this._pending = null;
        const restored = this._appliedPatches;
        const restoredGuards = this._appliedGuards;
        this._appliedPatches = [];
        this._appliedGuards = [];
        log(`${LOG_PREFIX} disabled, restored patches: ` +
            `${restored.length > 0 ? restored.join(', ') : '(none were applied)'}` +
            `, guards: ${restoredGuards.length > 0 ? restoredGuards.join(', ') : '(none)'}`);
    }

    /**
     * 还原两处补丁。可安全重复调用（已还原则是 no-op，且不会误报还原了 0 处）。
     * _orig 只在真正挂上过补丁时被置位，因此它的存在就是"当前是包裹态"的唯一判据。
     */
    _detachPatches() {
        const o = this._orig;
        if (!o)
            return;
        try {
            if (o.fdo && o.notify)
                o.fdo.NotifyAsync = o.notify;
        } catch {
            /* best effort */
        }
        try {
            if (o.fdo && o.getSource)
                o.fdo._getSourceForPidAndName = o.getSource;
        } catch {
            /* best effort */
        }
        this._orig = null;
    }

    // ---- 原生 messageList 缺陷兜底 ----
    //
    // 这不是分组逻辑，而是替 GNOME 50 的 UI 缺陷擦屁股，因此与上面的两个补丁点
    // 完全独立：拿不到 messageList.js 就只丢兜底，分组照常。
    //
    // 缺陷链（均已核对 native 源码行号）：
    //   _removeNotification  :1152 取 item = message.get_parent()，:1161 立刻用
    //                          item.layout_manager，而 _notificationToMessage.delete()
    //                          在动画 onComplete 里（:1170）-> :1161 一抛，脏条目
    //                          就永久留在 Map 里。
    //   collapse()           :992 forEach 里对脏条目调 unexpand -> Message.unexpand
    //                          :646 的 ease_property('@layout.expansion') 需要
    //                          layout manager，取不到即 TypeError。
    //   collapse()           :998/:1000 的 _expanded=false / cover.show() 排在那行
    //                          之后且无 try/finally -> 状态永久停在半折叠，
    //                          此后每次点击都被 :1114 的 if (!this.expanded) 吞掉，
    //                          用户看到的是"通知栏卡住、点什么都没反应"。
    //
    // 第二处（同一 section，机制不同）：折叠组里关一张卡会被 :1107 的 stop_emission +
    //   group.close() 升级成关整组。原生一个源≈一张卡时看不见；合并把一组变 N 张后，
    //   代价被放大。兜底只对本扩展自建源 + 折叠态改为只关这一张（见 _attachUiGuards）。

    /**
     * 还原 UI 兜底。可安全重复调用；_origUi 非 null 即"当前已挂"的唯一判据。
     */
    _detachUiGuards() {
        const o = this._origUi;
        if (!o)
            return;
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
        this._origUi = null;
    }

    /**
     * 挂 UI 兜底。用动态 import：上游一旦改名/删文件，静态 import 会让整个扩展
     * 进 ERROR 态、连分组都不再工作，而那比"没有兜底"糟得多。
     */
    async _attachUiGuards() {
        this._detachUiGuards();

        let mod = null;
        let detail = '';
        try {
            mod = await import('resource:///org/gnome/shell/ui/messageList.js');
        } catch (e) {
            detail = e && e.message ? e.message : String(e);
        }

        // 动态导入期间可能已经 disable：此时挂上去就再也无人还原了。
        if (!this._enabled)
            return;

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
            this._appliedGuards = [];
            log(`${LOG_PREFIX} UI guards degraded: ${check.warnings.join('; ')}`);
            return;
        }

        this._origUi = {
            Message,
            Group,
            NotificationMessage,
            unexpand: Message.prototype.unexpand,
            collapse: Group.prototype.collapse,
            notifClose: NotificationMessage.prototype.close,
        };

        const origUnexpand = this._origUi.unexpand;
        Message.prototype.unexpand = function (animate) {
            // actor 已从容器摘下时没有 layout manager，动画无从谈起；直接把终态
            // 落位并返回，让 collapse() 的 forEach 能跑完剩下的消息（否则一条脏
            // 消息会连带让它后面的消息全部留在展开态）。
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

        const origCollapse = this._origUi.collapse;
        Group.prototype.collapse = async function () {
            try {
                return await origCollapse.call(this);
            } catch (e) {
                logError(e, `${LOG_PREFIX} NotificationMessageGroup.collapse() threw`);
                // 只补状态落位，不改语义：半折叠态会让之后每次点击都被吞掉。
                try {
                    this._expanded = false;
                    this.notify('expanded');
                    this._cover?.show();
                } catch {
                    /* group already disposed */
                }
            }
        };

        // 第三处兜底：折叠组里点一张卡的 ×，原生会把 close 升级成"关整组"
        // （messageList.js:1107 先 stop_emission 再 group.close()）。原生一个源≈
        // 一张卡，代价看不见；合并让一组变 N 张，"关整组"的代价随之放大。这里只在
        // **本扩展创建的合并源**、且组处于折叠态时，改为只关这一张：直接跑 close
        // 信号的默认处理器 on_close()（GJS 按 on_<signal> 自动接线，实测确认），
        // 跳过派发，组处理器就不会把这次 close 升级成整组关闭。原生源、展开态、
        // 单卡组一律走原生路径（单卡组按 :952 的 getter 视为已展开）。
        const ownSources = this._ownSources;
        const origNotifClose = this._origUi.notifClose;
        NotificationMessage.prototype.close = function () {
            try {
                const item = this.get_parent();
                const group = item ? item.get_parent() : null;
                if (group instanceof Group && !group.expanded &&
                    ownSources.has(group.source) &&
                    typeof this.on_close === 'function') {
                    this.on_close();
                    return;
                }
            } catch {
                /* 判定失败就落回原生，绝不吞掉一次关闭 */
            }
            return origNotifClose.call(this);
        };

        this._appliedGuards = check.guards;
        log(`${LOG_PREFIX} UI guards attached: ${this._appliedGuards.join(', ')}`);
    }

    // ---- 挂接 FDO 实例 ----

    _attach() {
        const daemon = Main.notificationDaemon || null;
        const fdo = daemon ? daemon._fdoNotificationDaemon : null;
        const check = checkAttachPoints({
            hasFdo: !!fdo,
            fdoKeys: fdo
                ? Object.keys(fdo).join(',')
                : daemon
                    ? Object.keys(daemon).join(',')
                    : 'Main.notificationDaemon is null',
            hasNotifyAsync: !!(fdo && typeof fdo.NotifyAsync === 'function'),
            hasGetSource: !!(fdo && typeof fdo._getSourceForPidAndName === 'function'),
        });
        if (!check.attach) {
            this._appliedPatches = [];
            log(`${LOG_PREFIX} WARNING degraded, staying inert: ${check.warnings.join('; ')}`);
            return;
        }

        // 防重入：enable 未经 disable（_orig 仍指向上一轮的包裹层）时，必须先
        // 还原再重新取原始方法。否则会把包裹层当作原始方法存起来，disable 只能
        // 还原到包裹层，永久残留一个引用死实例的包裹。
        this._detachPatches();

        this._orig = {
            fdo,
            notify: fdo.NotifyAsync,
            getSource: fdo._getSourceForPidAndName,
        };

        const self = this;

        fdo.NotifyAsync = function (params, invocation) {
            // FDO Notify 参数位：0 app_name, 1 replaces_id, 2 app_icon,
            // 3 summary, 4 body, 5 actions, 6 hints, 7 timeout。
            // 入口处 hints 内仍是 GLib.Variant，需 deepUnpack。
            const hints = params[6] || {};
            const read = (k) => {
                try {
                    const v = hints[k];
                    return v ? v.deepUnpack() : null;
                } catch {
                    return null;
                }
            };
            const res = computeGroup({
                appName: params[0],
                desktopEntry: read('desktop-entry'),
            });
            // _pending 对所有调用都置位：Shell 认识 replaces_id 时走复用分支
            // （不经过 _getSource，暂存无影响）；Shell 不认识（stale id）则落
            // else 分支，_getSource 用暂存合并。暂存携带 pid 与原始 app_name
            // 两个一致性校验位——pid 只能发现跨进程错位，发现不了同一进程内以
            // 不同 app_name 交错发送（pid 相同、守卫放行），那才是会静默并进
            // 错误分组的情形，所以两个都记。
            self._pending = {
                res,
                pid: read('x-shell-sender-pid'),
                appName: params[0],
            };
            try {
                return self._orig.notify.call(this, params, invocation);
            } finally {
                self._pending = null;
            }
        };

        fdo._getSourceForPidAndName = function (sender, pid, appName) {
            const pend = self._pending;
            // 无暂存或 app_name 为空：原生直通，按 pid 隔离。
            if (!pend || !pend.res.mergeable)
                return self._orig.getSource.call(this, sender, pid, appName);
            // 防御：暂存 pid 与本次调用 pid 不一致 -> 同步假设被发行版补丁
            // 破坏（NotifyAsync 引入 await/重入）。落安全侧：原生直通 + 单行告警。
            if (pend.pid != null && pid != null && pend.pid !== pid) {
                self._warnOnce('pending-mismatch',
                    `pending 错位: 暂存 pid=${pend.pid} vs 调用 pid=${pid}，按原生直通（同步假设失效，请上报）`);
                return self._orig.getSource.call(this, sender, pid, appName);
            }
            // 防御：暂存的 app_name 与本次调用的不一致 -> 暂存属于另一条通知
            // （同一发送者进程交错）。此时 groupKey 是按别人的名字算的，必须
            // 直通，否则会把这条通知并进别人的栈并连带改变栈标题。
            if (pend.appName !== appName) {
                self._warnOnce('pending-appname-mismatch',
                    `pending 错位: 暂存 app_name=${JSON.stringify(pend.appName)} vs 调用 ` +
                    `${JSON.stringify(appName)}，按原生直通（同步假设失效，请上报）`);
                return self._orig.getSource.call(this, sender, pid, appName);
            }
            const key = pend.res.groupKey;
            const rec = self._shared.get(key);
            if (rec)
                return rec.source;
            const source = self._orig.getSource.call(this, sender, pid, appName);

            // 第三挂载点（与分组补丁相互独立、独立降级）：合并源没有 app（本路径
            // 原生即传 null），原生 Source.open() = openApp()（对 null app 是
            // no-op，也不关日历）+ destroyNonResidentNotifications()，后者把**整个
            // 共享源**里的非驻留通知一起清掉。原生一个源≈一个 sender，清掉的通常
            // 只有一张；合并把作用域放大成整组 —— 用户看到"点一张卡 -> 空白一片 ->
            // 整组消失"。这里只保留"打开应用"那半句，去掉批量销毁；被点的那张仍由
            // Notification.activate() 随后的 destroy() 自行销掉，于是点哪张只删哪张。
            let origOpen = null;
            let patchedOpen = null;
            const rawOpen = source.open;
            if (typeof rawOpen === 'function') {
                origOpen = rawOpen;
                patchedOpen = function () {
                    if (typeof this.openApp === 'function')
                        return this.openApp();
                };
                source.open = patchedOpen;
            } else {
                self._warnOnce('source-open-missing',
                    'FdoNotificationDaemonSource.open 不可用，点一张卡仍会清空整组（请上报）');
            }

            self._ownSources.add(source);
            // destroy 自清：仅当缓存里仍是本源时才删（防旧源的延迟 destroy
            // 误删同 key 的新源）。
            const hid = source.connect('destroy', () => {
                const cur = self._shared.get(key);
                if (cur && cur.source === source) {
                    self._shared.delete(key);
                    self._ownSources.delete(source);
                }
            });
            self._shared.set(key, { source, hid, origOpen, patchedOpen });
            return source;
        };

        this._appliedPatches = check.patches;
        log(`${LOG_PREFIX} enabled, attached patches: ${this._appliedPatches.join(', ')}`);

        // 分组已挂上才谈兜底（兜底独立降级，但不会在惰性实例上单独存在）。
        // 不 await：enable() 必须保持同步，与 _pending 的同步交接假设一致。
        this._attachUiGuards().catch(e => {
            logError(e, `${LOG_PREFIX} UI guards attach failed`);
        });
    }

    _warnOnce(key, msg) {
        if (this._warned.has(key))
            return;
        this._warned.add(key);
        log(`${LOG_PREFIX} WARNING ${msg}`);
    }
}
