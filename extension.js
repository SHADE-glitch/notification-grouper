// notification-grouper@local — GNOME 50 通用通知分组（零配置，只按发出应用分组）。
//
// 机制：只挂接 FDO 实例的两个方法（自降级：缺任一 -> 完全惰性，不半挂载）：
//  1. NotifyAsync 包裹层：入口读 hints（deepUnpack），computeGroup()（纯函数，
//     见 groupEngine.js）得 {groupKey, mergeable}，暂存闭包 _pending（携带
//     senderPid）。50.1 源码核对：NotifyAsync 为同步方法（notificationDaemon.js），
//     从入口到 Source 查找之间无 await，整文件无 async——try/finally 暂存安全
//     （JS 单线程 + D-Bus 同步派发，无重入）。
//  2. _getSourceForPidAndName 包裹层：消费 _pending。mergeable 时按 groupKey
//     复用/新建共享 Source；mergeable=false（app_name 为空）一律原生直通。
//     已解析到 source.app 的走 _getSourceForApp，原生已按 App 成栈，本扩展不碰；
//     Gtk 路径（GtkNotificationDaemon*）是另一个独立对象与类，不引用不 patch。
//
// 覆盖范围：所有解析不到 App 的来源（_getSourceForPidAndName 路径）——有 app_name
// 但无 App 的来源，原生每次新 pid 建新 Source，本扩展按归一化 app_name 合并到
// 同一共享 Source，实现"按发出应用分组"。
//
// 界面/点击/图标/上限全部走原生：不覆盖 _appName/_appIcon，不注入按钮，不遮蔽
// source.open()（点一张卡 = 原生 open() -> destroyNonResidentNotifications()，
// 与原生堆叠源行为一致）。disable 时还原两处补丁、断开每源信号、清空缓存。
//
// 日志：默认安静——enable/attach/disable 各一行；无 per-notify 日志，永不记 body。

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { computeGroup, checkAttachPoints } from './groupEngine.js';

const LOG_PREFIX = '[notification-grouper]';

export default class NotificationGrouperExtension extends Extension {
    _enabled = false;
    /** groupKey -> {source, hid}（共享 Source 缓存，destroy 自清） */
    _shared = new Map();
    /** 当前同步调用中的 computeGroup 结果与校验上下文（见文件头设计 1） */
    _pending = null;
    _orig = null;
    _appliedPatches = [];
    _warned = new Set();

    enable() {
        this._enabled = true;
        this._shared = new Map();
        this._pending = null;
        this._appliedPatches = [];
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
        for (const [, rec] of this._shared) {
            try {
                rec.source.disconnect(rec.hid);
            } catch {
                /* already gone */
            }
        }
        this._shared.clear();
        this._pending = null;
        const restored = this._appliedPatches;
        this._appliedPatches = [];
        log(`${LOG_PREFIX} disabled, restored patches: ` +
            `${restored.length > 0 ? restored.join(', ') : '(none were applied)'}`);
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
            // else 分支，_getSource 用暂存合并。暂存携带 pid 供一致性校验。
            self._pending = { res, pid: read('x-shell-sender-pid') };
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
            const key = pend.res.groupKey;
            const rec = self._shared.get(key);
            if (rec)
                return rec.source;
            const source = self._orig.getSource.call(this, sender, pid, appName);
            // destroy 自清：仅当缓存里仍是本源时才删（防旧源的延迟 destroy
            // 误删同 key 的新源）。
            const hid = source.connect('destroy', () => {
                const cur = self._shared.get(key);
                if (cur && cur.source === source)
                    self._shared.delete(key);
            });
            self._shared.set(key, { source, hid });
            return source;
        };

        this._appliedPatches = check.patches;
        log(`${LOG_PREFIX} enabled, attached patches: ${this._appliedPatches.join(', ')}`);
    }

    _warnOnce(key, msg) {
        if (this._warned.has(key))
            return;
        this._warned.add(key);
        log(`${LOG_PREFIX} WARNING ${msg}`);
    }
}
