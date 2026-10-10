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
// 三处 UI 方法兜底、断开每源信号，并**销毁本扩展自建的合并源**（它们持有的
// watch_name 与 policy 只在 destroy() 里释放，且留着的话还原后的原生 open() 会重新
// 批量清空整组）——于是禁用即撤销本扩展造成的全部状态。
//
// 日志：默认安静——enable/attach/disable 各一行；无 per-notify 日志，永不记 body。
//
// UI 兜底在 uiWorkarounds.js：GNOME 50 原生 messageList.js 有三处会把 N 卡合并组坑到的
// 行为（折叠竞态 ×2、关一张升级成关整组）。取不到 messageList.js 只丢兜底、分组照常；
// 上游修复后那个文件整块删除——所以它是独立的一个模块，不是这里的三段注释。

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { NotificationDestroyedReason } from 'resource:///org/gnome/shell/ui/messageTray.js';

import { computeGroup, checkAttachPoints, normalizeIsolate } from './groupEngine.js';
import * as UiWorkarounds from './uiWorkarounds.js';

// 原生条数上限。schema 里 max-per-source 的上界必须等于它——超过 10 需要复制原生
// addNotification（销毁旧条目 + 两处 connect + push + countUpdated），多一个脆弱补丁点。
const NATIVE_MAX_PER_SOURCE = 10;

const LOG_PREFIX = '[notification-grouper]';

export default class NotificationGrouperExtension extends Extension {
    _enabled = false;
    /** groupKey -> {source, hid, origOpen, patchedOpen}（共享 Source 缓存，destroy 自清） */
    _shared = new Map();
    /** 本扩展创建的合并 Source 集合：UI 兜底据此判断"这张卡属于本扩展" */
    _ownSources = new Set();
    /** 当前同步调用中的 computeGroup 结果与校验上下文（见文件头设计 1） */
    _pending = null;
    _orig = null;
    _appliedPatches = [];
    _warned = new Set();
    /** 设置缓存：热路径只读内存，绝不每个通知去 get_*（changed:: 时刷新） */
    _settings = null;
    /** changed:: 的 handler id，disable() 必须逐个 disconnect */
    _settingsHids = [];
    _groupingEnabled = true;
    _uiGuardsEnabled = true;
    _maxPerSource = NATIVE_MAX_PER_SOURCE;
    _isolated = new Set();

    enable() {
        this._enabled = true;
        // 只重置纯记账字段。**绝不**在这里重建 _shared / _ownSources：它们登记的是
        // 上一轮已挂到别人对象上的补丁（自建源的 open() 覆盖、每源 destroy 连接）。
        // 一重建就没人持有它们，disable() 便无从还原——补丁跨 disable 存活，
        // 且 close 兜底会因 _ownSources 丢条目而无声失效。
        // 与 _attach() 先 _detachPatches() 是同一条不变量：enable() 必须幂等。
        this._pending = null;
        this._appliedPatches = [];
        this._warned = new Set();
        // 先读设置再挂接：包装层与兜底挂载都依赖这些缓存值。
        this._loadSettings();
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
        const restoredGuards = UiWorkarounds.detach();
        this._teardownSettings();
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
            // 本扩展自建的源不得活过 disable()。它持有一个 Gio.DBus.watch_name 订阅和
            // 一个 NotificationPolicy，两者只在 Source.destroy() 里释放
            // （messageTray.js:597-609：policy.destroy() + run_dispose()）；更关键的是
            // 还原成原生 open() 之后，原生那方法的第二步 destroyNonResidentNotifications()
            // 会重新作用在一个多卡源上，"点一张卡清掉整组"于是回到禁用之后。
            // 到这里 rec 仍在表里，说明该源没被销毁过（销毁会经 rec.hid 自清这条记录），
            // 所以不存在二次 destroy。
            try {
                rec.source.destroy();
            } catch {
                /* source already disposed */
            }
        }
        this._shared.clear();
        this._ownSources.clear();
        this._pending = null;
        const restored = this._appliedPatches;
        this._appliedPatches = [];
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

    // ---- 设置 ----
    //
    // schema 随扩展目录走（schemas/ + metadata 的 settings-schema；shell 侧实现在
    // extensions/sharedInternals.js:92，50 起不再自动编译 schema，所以 gschemas.compiled
    // 必须与 .xml 同笔提交）。职责只有两条：读一次缓存进内存（热路径每条通知读缓存，
    // 绝不做 IO），changed:: 时刷新。handler id 全部记进 _settingsHids，disable() 逐个
    // disconnect —— 与补丁同一条规矩：登记了就必须有路径撤销它。
    // 日志只在两个开关上各一行（那是用户动作，不是通知）；上限拖动会连发，故意不打。

    _loadSettings() {
        const s = this.getSettings();
        this._settings = s;
        this._readSettings();
        this._settingsHids = [
            s.connect('changed::grouping-enabled', () => {
                this._groupingEnabled = s.get_boolean('grouping-enabled');
                log(`${LOG_PREFIX} grouping ${this._groupingEnabled ? 'on' : 'off'}`);
            }),
            s.connect('changed::ui-guards', () => {
                this._uiGuardsEnabled = s.get_boolean('ui-guards');
                log(`${LOG_PREFIX} UI guards ${this._uiGuardsEnabled ? 'on' : 'off'}`);
                this._mountUiGuards();
            }),
            s.connect('changed::max-per-source', () => {
                this._maxPerSource = s.get_int('max-per-source');
                // 没有"下一条"要塞，所以现存堆叠削到上限本身（不是 cap-1）
                for (const [, rec] of this._shared)
                    this._evictTo(rec.source, this._maxPerSource);
            }),
            s.connect('changed::isolate-apps', () => this._readSettings()),
        ];
    }

    _readSettings() {
        const s = this._settings;
        this._groupingEnabled = s.get_boolean('grouping-enabled');
        this._uiGuardsEnabled = s.get_boolean('ui-guards');
        this._maxPerSource = s.get_int('max-per-source');
        this._isolated = normalizeIsolate(s.get_strv('isolate-apps'));
    }

    _teardownSettings() {
        const s = this._settings;
        if (!s)
            return;
        for (const id of this._settingsHids)
            s.disconnect(id);
        this._settingsHids = [];
        this._settings = null;
    }

    /**
     * 把堆叠削到 keep 条，镜像原生 messageTray.js:577-579 的语义（销毁最旧、
     * reason=EXPIRED）。调用时机只有两处，且都必须保证**削完还剩至少一条**：
     *  1. NotifyAsync 里原生 push **之后**，keep = max-per-source（length 此时是
     *     cap+1，于是可见条数正好是 cap）；
     *  2. 设置项被调小时，对现存堆叠立刻修剪，keep = 新 cap。
     * keep=0 是禁止的：原生见到底层空掉就 `this.destroy()`（messageTray.js:569-570），
     * 那个源随后会被原生继续 push，直接踩到已 dispose 的对象。
     * reason 必须是 EXPIRED：FDO 侧按它决定发给应用的是 NotificationClosed(EXPIRED)
     * 还是 (DISMISSED)（notificationDaemon.js:178-195），传错等于替用户"手动关闭"了它。
     * cap == NATIVE_MAX_PER_SOURCE 时循环条件与原生等价，不必特判。
     */
    _evictTo(source, keep) {
        while (source.notifications.length > keep) {
            const [oldest] = source.notifications;
            oldest.destroy(NotificationDestroyedReason.EXPIRED);
        }
    }

    /**
     * 按开关挂/撤三处 UI 兜底。attach() 自己先 detach，所以来回拨不叠层（与 enable()
     * 的幂等同一条不变量）。不 await：enable() 必须保持同步，与 _pending 交接假设一致。
     */
    _mountUiGuards() {
        if (!this._uiGuardsEnabled) {
            UiWorkarounds.detach();
            return;
        }
        UiWorkarounds.attach({
            ownsSource: src => this._ownSources.has(src),
            log: m => log(`${LOG_PREFIX} ${m}`),
            onError: (e, m) => logError(e, `${LOG_PREFIX} ${m}`),
            // 动态导入期间可能已 disable，或用户已把兜底开关拨掉：那时挂上去就无人还原。
            alive: () => this._enabled && this._uiGuardsEnabled,
        }).then(guards => {
            if (guards.length > 0)
                log(`${LOG_PREFIX} UI guards attached: ${guards.join(', ')}`);
        }).catch(e => {
            logError(e, `${LOG_PREFIX} UI guards attach failed`);
        });
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
                enabled: self._groupingEnabled,
                isolated: self._isolated,
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
                // 削位必须在 push **之后**。原生在源的最后一条通知被销毁时会连带
                // 销毁整个源（messageTray.js:569-570），若在 push 前把它清空，紧接着
                // 的原生 addNotification 就在操作一个已 dispose 的对象——实测
                // Gjs-CRITICAL "has been already disposed"，栈里我们的包装帧在下面
                // 两帧（notificationDaemon.js:266 → :367 → messageTray.js:592）。
                // NotifyAsync 是同步的，所以返回时通知已经进了源，这里削到 cap 条
                // 既精确又绝不会把源清空（cap >= 1，length = cap + 1）。
                const served = self._pending && self._pending.servedSource;
                if (served)
                    self._evictTo(served, self._maxPerSource);
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
            if (rec) {
                // 复用已有源。这里**不能**削位：削到 cap-1 在 cap=1 时会把源清空，
                // 而原生见到底层空掉就 self.destroy()（messageTray.js:569-570），
                // 紧接着的 addNotification 会踩到已 dispose 的对象。只登记"这条被
                // 我接管了"，削位交给 NotifyAsync 包裹层在 push 之后做。
                pend.servedSource = rec.source;
                return rec.source;
            }
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
            // 新建源同理：削位不在这里做，登记后交给 push 之后的那段。
            pend.servedSource = source;
            return source;
        };

        this._appliedPatches = check.patches;
        log(`${LOG_PREFIX} enabled, attached patches: ${this._appliedPatches.join(', ')}`);

        // 分组已挂上才谈兜底（兜底独立降级，但不会在惰性实例上单独存在）。
        this._mountUiGuards();
    }

    _warnOnce(key, msg) {
        if (this._warned.has(key))
            return;
        this._warned.add(key);
        log(`${LOG_PREFIX} WARNING ${msg}`);
    }
}
