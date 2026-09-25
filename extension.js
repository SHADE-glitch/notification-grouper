// notification-grouper@local — 通用通知分组扩展（GNOME 50）。
//
// 设计（Q1 选 c，只改 FDO 实例的 Source 缓存键推导，不改替换语义）：
//  1. groupKey 传递：在实例 NotifyAsync 包裹层先调 computeGroup()（纯函数，
//     见 groupEngine.js），结果暂存闭包，_getSourceForPidAndName 包裹层消费。
//     50.1 源码核对：NotifyAsync 为同步方法（notificationDaemon.js:135），
//     从入口到 Source 查找（:169-174）之间无任何 await，整文件无 async——
//     try/finally 暂存安全（JS 单线程 + D-Bus 同步派发，无重入）。
//     防御（R1）：暂存携带 senderPid，_getSource 消费时校验 pid 一致；
//     不一致说明同步假设被发行版补丁破坏 -> 单行告警 + 落安全侧（原生直通）。
//  2. 覆盖范围：所有解析不到 App 的来源（_getSourceForPidAndName 路径），
//     不只是 notify-send——有 app_name、无 App 的来源同样每次新 pid 建新
//     Source，一并按 mergeable 的 groupKey 合并。已解析到 source.app 的走
//     _getSourceForApp，原生已按 App 成栈，默认不碰。Gtk 路径
//     （GtkNotificationDaemon*）是另一个独立对象与类，本扩展不引用不 patch。
//  3. 组头显示：共享 Source 在 processNotification 包裹层（仅 _ngGroupKey
//     标记的源生效）于原逻辑之后强制覆盖 _appName 为 displayName（规则显式
//     displayName 优先，支持 {count} 占位或 showCount 追加计数，否则
//     humanizeGroupKey）；规则 iconName 显式配置时覆盖 _appIcon，未配置沿用
//     原生回退（首条通知的 appIcon，last-write-wins）。只改 Shell 侧对象，
//     不改总线载荷。disable 时还原首次覆盖前 stash 的原名/原图标。
//  4. 生命周期：共享 Source 建时连 'destroy' 自清缓存与 TTL 定时器；
//     replace/窗口折叠均为先加新卡再销毁旧卡（避免源被清空自毁）；
//     TTL 每源单 timer + 队列（不再每通知一 timer），懒清理已死条目；
//     disable 还原全部补丁、断开文件监视、清 TTL/日志定时器、断每源信号、
//     还原组头、销毁注入的清组按钮、清空缓存（存活通知继续原生工作）。
//  5. 清组按钮：patch messageList.NotificationMessageGroup.prototype
//     ._addNotification（第 4 处补丁，独立于核心三补丁的自降级：缺失只跳过
//     按钮不拖垮核心），仅给 _ngGroupKey 托管源的组头注入清除按钮，
//     点击销毁该组全部非 resident 卡（与原生 destroyNonResidentNotifications
//     同语义），通用无应用分支。
//
// 点击语义：托管源实例 open() 遮蔽为 no-op，点击 = 仅关闭被点单卡。
// 日志：默认聚合——同 (action,group,src) 5s 窗口内合并为计数行；首条即记；
//   建源/复用/直通/淘汰/TTL 均可见。debug=true 时每通知一行并附 title。
//   永不记 body（body 只进引擎做 bodyPattern 匹配）。
// 规则：rules.json + FileMonitor 热加载；compileRules 一次性 校验+审计+预编译，
//   JSON 解析失败整体沿用旧规则（回滚）；条目级错误/危险 pattern 单行告警并拒载。

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { computeGroup, humanizeGroupKey, checkAttachPoints, compileRules, NATIVE_SOURCE_LIMIT } from './groupEngine.js';

const LOG_PREFIX = '[notification-grouper]';
const LOG_FLUSH_SEC = 5;

export default class NotificationGrouperExtension extends Extension {
    _enabled = false;
    _rules = null;
    _rulesMonitor = null;
    _rulesMonitorId = 0;
    /** groupKey -> {source, id, derivedFrom} */
    _shared = new Map();
    /** 存活的 TTL 定时器 id（disable 时全部清除；每源至多一个） */
    _ttlTimers = new Set();
    _sourceSeq = 0;
    /** 当前同步调用中的 computeGroup 结果与校验上下文（见文件头设计 1） */
    _pending = null;
    _orig = null;
    _FdoSrc = null;
    _ClearGroupClass = null;
    _appliedPatches = [];
    /** 日志聚合：(action|group|src) -> {count, line} */
    _logAgg = new Map();
    _logFlushTimer = 0;
    _warned = new Set();
    _clearBtns = new Set();

    enable() {
        this._enabled = true;
        this._shared = new Map();
        this._sourceSeq = 0;
        this._pending = null;
        this._warned = new Set();
        this._loadRules();
        this._watchRules();
        log(`${LOG_PREFIX} enabled, loading daemon modules…`);
        Promise.all([
            import('resource:///org/gnome/shell/ui/notificationDaemon.js'),
            import('resource:///org/gnome/shell/ui/messageList.js'),
        ]).then(([daemonMod, msgListMod]) => {
            if (!this._enabled)
                return; // enable 后 disable 又发生在模块返回前
            try {
                this._attach(daemonMod, msgListMod);
            } catch (e) {
                logError(e, `${LOG_PREFIX} attach failed, staying inert`);
            }
        }).catch(e => {
            logError(e, `${LOG_PREFIX} cannot import daemon modules`);
        });
    }

    disable() {
        this._enabled = false;
        if (this._rulesMonitorId && this._rulesMonitor) {
            try {
                this._rulesMonitor.disconnect(this._rulesMonitorId);
            } catch {
                /* already gone */
            }
        }
        this._rulesMonitorId = 0;
        this._rulesMonitor = null;
        const o = this._orig;
        if (o) {
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
            try {
                if (this._FdoSrc && o.process)
                    this._FdoSrc.prototype.processNotification = o.process;
            } catch {
                /* best effort */
            }
            try {
                if (this._ClearGroupClass && o.clearAdd)
                    this._ClearGroupClass.prototype._addNotification = o.clearAdd;
            } catch {
                /* best effort */
            }
        }
        for (const tid of this._ttlTimers) {
            try {
                GLib.source_remove(tid);
            } catch {
                /* best effort */
            }
        }
        this._ttlTimers.clear();
        if (this._logFlushTimer) {
            try {
                GLib.source_remove(this._logFlushTimer);
            } catch {
                /* best effort */
            }
            this._logFlushTimer = 0;
        }
        this._logAgg.clear();
        for (const btn of this._clearBtns) {
            try {
                btn.destroy();
            } catch {
                /* already gone */
            }
        }
        this._clearBtns.clear();
        this._orig = null;
        this._FdoSrc = null;
        this._ClearGroupClass = null;
        const restored = this._appliedPatches;
        this._appliedPatches = [];
        for (const [, rec] of this._shared) {
            const s = rec.source;
            try {
                delete s.open;
            } catch {
                /* best effort */
            }
            // 断开每源信号（destroy / notification-removed）
            for (const hid of s._ngHnd ?? []) {
                try {
                    s.disconnect(hid);
                } catch {
                    /* best effort */
                }
            }
            s._ngHnd = [];
            // 还原组头与图标（R8：首次覆盖前 stash 的原值）
            try {
                if (s._ngOrigAppName !== undefined) {
                    s._appName = s._ngOrigAppName;
                    s._appIcon = s._ngOrigAppIcon;
                    s.notify('title');
                    s.notify('icon');
                }
            } catch {
                /* best effort */
            }
        }
        this._shared.clear();
        this._pending = null;
        log(`${LOG_PREFIX} disabled, restored patches: ` +
            `${restored.length > 0 ? restored.join(', ') : '(none were applied)'}`);
    }

    // ---- 规则加载（GSettings 不用；JSON + FileMonitor 热加载） ----

    get _rulesPath() {
        return GLib.build_filenamev([this.path, 'rules.json']);
    }

    _loadRules() {
        let parsed;
        try {
            const file = Gio.File.new_for_path(this._rulesPath);
            const [ok, bytes] = file.load_contents(null);
            if (!ok)
                throw new Error('load_contents failed');
            parsed = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            if (!this._rules)
                this._rules = compileRules({}).rules;
            // 坏文件只记单行（不刷堆栈），整体沿用旧规则继续工作（回滚）。
            log(`${LOG_PREFIX} rules load failed, keeping previous: ${e && e.message ? e.message : e}`);
            return;
        }
        // 校验+审计+预编译一次性完成；条目级问题单行告警并拒载，不进热路径。
        const { rules, errors, rejected } = compileRules(parsed);
        for (const e of errors)
            log(`${LOG_PREFIX} rules error: ${e.where} ${e.reason}`);
        for (const r of rejected)
            log(`${LOG_PREFIX} rules reject pattern=${JSON.stringify(r.pattern)} ` +
                `where=${r.where} reason=${r.reason} (stays unloaded)`);
        this._rules = rules;
        const g = Object.keys(rules.groups).length;
        log(`${LOG_PREFIX} rules loaded: ${rules.titlePrefixRules.length} title rules, ` +
            `${rules.sourceRules.length} source rules, ${rules.blockRules.length} block rules, ` +
            `${g} groups, heuristic=${rules.heuristicTitlePrefix}, debug=${rules.debug}` +
            `${errors.length || rejected.length ? ` (${errors.length} errors, ${rejected.length} rejected)` : ''}`);
        this._reapplyRulesToShared();
    }

    _watchRules() {
        try {
            const file = Gio.File.new_for_path(this._rulesPath);
            this._rulesMonitor = file.monitor(Gio.FileMonitorFlags.NONE, null);
            this._rulesMonitorId = this._rulesMonitor.connect('changed', () => {
                if (!this._enabled)
                    return;
                this._loadRules();
            });
        } catch (e) {
            logError(e, `${LOG_PREFIX} cannot watch rules.json`);
        }
    }

    // ---- 挂接 FDO 实例 ----

    _attach(mod, msgListMod) {
        // 自降级：任一核心补丁点不存在只记一条警告并整体不生效（不抛错、不半挂载）。
        const FdoSrc = mod && mod.FdoNotificationDaemonSource;
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
            hasFdoSourceClass: !!FdoSrc,
            hasProcessNotification: !!(
                FdoSrc && typeof FdoSrc.prototype.processNotification === 'function'),
        });
        if (!check.attach) {
            this._appliedPatches = [];
            log(`${LOG_PREFIX} WARNING degraded, staying inert: ${check.warnings.join('; ')}`);
            return;
        }

        this._FdoSrc = FdoSrc;
        this._orig = {
            fdo,
            notify: fdo.NotifyAsync,
            getSource: fdo._getSourceForPidAndName,
            process: FdoSrc.prototype.processNotification,
            clearAdd: null,
        };

        const self = this;

        fdo.NotifyAsync = function (params, invocation) {
            // FDO Notify 参数位：0 app_name, 1 replaces_id, 2 app_icon,
            // 3 summary, 4 body, 5 actions, 6 hints, 7 timeout。
            // 注意：入口处 hints 内仍是 GLib.Variant，需 deepUnpack。
            const hints = params[6] || {};
            const read = (k) => {
                try {
                    const v = hints[k];
                    return v ? v.deepUnpack() : null;
                } catch {
                    return null;
                }
            };
            const entry = read('desktop-entry');
            const senderPid = read('x-shell-sender-pid');
            const urgency = read('urgency');
            const res = computeGroup({
                appName: params[0],
                desktopEntry: entry,
                title: params[3],
                body: params[4], // 只进引擎做 bodyPattern 匹配，永不记日志
                urgency,
                senderPid,
            }, self._rules);

            // ignoreReplaces（规则显式 opt-in）：剥离发送方 replaces_id，
            // 每事件强制新卡并入同组。默认关闭——尊重发送方原位更新语义。
            let stripped = false;
            if (res.mergeable && res.ignoreReplaces && params[1] !== 0) {
                params[1] = 0;
                stripped = true;
            }
            // _pending 对所有调用都置位（含 replaces_id≠0）：Shell 认识该 id 时
            // 走复用分支（不经过 _getSource，暂存无影响）；Shell 不认识（stale id）
            // 则落 else 分支，_getSource 用暂存合并。暂存携带 pid 供 R1 校验。
            self._pending = { res, pid: senderPid };
            if (stripped) {
                self._logEvent(res, {
                    appName: params[0], entry, pid: senderPid,
                    title: params[3], src: '?', action: 'replaces已剥离(规则强制新卡)',
                    nid: null,
                });
            }
            if (params[1] !== 0) {
                try {
                    const ret = self._orig.notify.call(this, params, invocation);
                    // Shell 认识该 id：orig 直接复用旧卡（不经过 _getSource）。
                    // 归属查询 O(1)：源对象自带 _ngId/_ngGroupKey 标记。
                    try {
                        const n = self._orig.fdo._notifications.get(params[1]);
                        if (n) {
                            const s = n.source;
                            const managed = !!(s && s._ngGroupKey);
                            self._logEvent(res, {
                                appName: params[0], entry, pid: senderPid,
                                title: params[3],
                                src: managed ? `#${s._ngId}` : 'native',
                                action: managed ? `replaces复用共享源#${s._ngId}` : 'replaces复用原生源',
                                nid: params[1],
                            });
                        }
                    } catch {
                        /* 归属查询失败不影响通知本身 */
                    }
                    return ret;
                } finally {
                    self._pending = null;
                }
            }
            try {
                const ret = self._orig.notify.call(this, params, invocation);
                // FDO 守护按 _nextNotificationId 顺序发号（同步段内无重入），
                // 供生命周期测试（CloseNotification）定位通知。
                let nid = null;
                try {
                    nid = self._orig.fdo._nextNotificationId - 1;
                } catch {
                    nid = null;
                }
                self._lastAssignedId = nid;
                return ret;
            } finally {
                self._pending = null;
            }
        };

        fdo._getSourceForPidAndName = function (sender, pid, appName) {
            const pend = self._pending;
            let nid = null;
            try {
                nid = self._orig.fdo._nextNotificationId - 1;
            } catch {
                nid = null;
            }
            if (!pend || !pend.res.mergeable) {
                if (pend) {
                    self._logEvent(pend.res, {
                        appName, entry: null, pid, title: null,
                        src: 'native', action: '原生直通', nid,
                    });
                }
                return self._orig.getSource.call(this, sender, pid, appName);
            }
            // R1 校验：暂存 pid 与本次调用 pid 不一致 -> 同步假设被发行版补丁
            // 破坏（NotifyAsync 引入 await/重入）。落安全侧：原生直通 + 单行告警。
            if (pend.pid != null && pid != null && pend.pid !== pid) {
                self._warnOnce('pending-mismatch',
                    `pending 错位: 暂存 pid=${pend.pid} vs 调用 pid=${pid}，按原生直通（同步假设失效，请上报）`);
                return self._orig.getSource.call(this, sender, pid, appName);
            }
            const res = pend.res;
            const key = res.groupKey;
            const rec = self._shared.get(key);
            if (rec) {
                self._logEvent(res, {
                    appName, entry: null, pid, title: null,
                    src: `#${rec.id}`, action: `复用共享源#${rec.id}`, nid,
                });
                return rec.source;
            }
            const source = self._orig.getSource.call(this, sender, pid, appName);
            const id = ++self._sourceSeq;
            source._ngGroupKey = key;
            source._ngId = id;
            self._applyGroupCfg(source, res);
            // 点击语义：托管源（匿名，无 App）的 open() 原本会 destroyNonResidentNotifications，
            // 点 1 张卡则同组全灭 + 横幅状态机竞争（"点击卡住"根因）。
            // 改为 no-op 后点击 = 仅关闭被点单卡（activate 自毁本卡），兄弟卡与总览不受影响。
            // 仅实例级遮蔽，不碰原型与 Gtk/原生源。
            source.open = function () {
            };
            source._ngHnd = [];
            source._ngHnd.push(source.connect('destroy', () => {
                self._ttlDisarm(source);
                const cur = self._shared.get(key);
                if (cur && cur.source === source)
                    self._shared.delete(key);
            }));
            // 组头计数/图标在删卡后也要刷新（加卡由 processNotification 包裹层触发）
            source._ngHnd.push(source.connect('notification-removed', () => {
                if (self._enabled && source._ngGroupKey && !source._inDestruction)
                    self._enforceHeader(source);
            }));
            self._shared.set(key, { source, id, derivedFrom: res.derivedFrom });
            self._logEvent(res, {
                appName, entry: null, pid, title: null,
                src: `#${id}`, action: `新建共享源#${id}`, nid,
            });
            return source;
        };

        FdoSrc.prototype.processNotification = function (notification, appName, appIcon) {
            const key = this._ngGroupKey;
            // 非本扩展托管源：原样直通（Q2 隔离）。
            if (!key || !self._enabled)
                return self._orig.process.call(this, notification, appName, appIcon);
            // 先加新卡，再按模式清理旧卡——避免源被清空自毁（设计 4）。
            self._orig.process.call(this, notification, appName, appIcon);
            if (this._ngMode === 'replace') {
                const olds = this.notifications.filter(n => n !== notification);
                for (const n of olds) {
                    try {
                        n.destroy(MessageTray.NotificationDestroyedReason.REPLACED);
                    } catch {
                        /* already gone */
                    }
                }
            }
            // 每组上限（原生 10 在 orig.process 的 addNotification 内已强制；
            // 规则 limit 更小时在此收紧）。
            const limit = Number.isInteger(this._ngLimit) && this._ngLimit > 0
                ? this._ngLimit
                : NATIVE_SOURCE_LIMIT;
            while (this.notifications.length > limit) {
                const oldest = this.notifications[0];
                if (oldest === notification && this.notifications.length === 1)
                    break;
                try {
                    oldest.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
                    self._logEnforce(this, `limit淘汰(上限${limit})`);
                } catch {
                    break;
                }
            }
            // 时间窗口折叠（规则显式 collapseWindowSec>0）：窗口内新卡顶替上一张。
            // 先加后删；replaces 更新同一卡（last.n === notification）不计为新事件。
            const win = this._ngCollapseWindowSec;
            if (win > 0) {
                const now = Date.now();
                const last = this._ngLastN;
                if (last && last.n !== notification &&
                    now - last.ts <= win * 1000 &&
                    this.notifications.includes(last.n)) {
                    try {
                        last.n.destroy(MessageTray.NotificationDestroyedReason.REPLACED);
                        self._logEnforce(this, `窗口折叠(${win}s)`);
                    } catch {
                        /* already gone */
                    }
                }
                this._ngLastN = { n: notification, ts: now };
            }
            // TTL（仅规则显式 ttlSec>0 的组；每源单 timer + 队列）
            self._armTtl(this, notification);
            self._enforceHeader(this);
        };

        this._appliedPatches = check.patches;
        // 第 4 处补丁（可选）：清组按钮注入。独立于核心自降级——缺失只跳过按钮。
        try {
            this._attachClearButton(msgListMod);
            if (this._ClearGroupClass)
                this._appliedPatches = [...check.patches, 'clearGroupButton'];
            else
                log(`${LOG_PREFIX} clear-group button skipped: NotificationMessageGroup._addNotification unavailable`);
        } catch (e) {
            this._ClearGroupClass = null;
            log(`${LOG_PREFIX} WARNING clear-group button unavailable, skipped: ${e && e.message ? e.message : e}`);
        }
        log(`${LOG_PREFIX} enabled, attached patches: ${this._appliedPatches.join(', ')} (Q1-c key-derivation)`);
    }

    // 清组按钮：给托管源的组头注入"清除整组"（销毁组内全部非 resident 卡，
    // 与原生 destroyNonResidentNotifications 同语义）。GNOME 50 原生组头只有
    // 展开按钮、无计数无清组（messageList.js 已核对），此为通用补齐。
    _attachClearButton(msgListMod) {
        const Group = msgListMod && msgListMod.NotificationMessageGroup;
        if (!Group || typeof Group.prototype._addNotification !== 'function')
            return; // 静默跳过（核心不受影响），_ClearGroupClass 保持 null
        const self = this;
        const origAdd = Group.prototype._addNotification;
        this._orig.clearAdd = origAdd;
        this._ClearGroupClass = Group;
        Group.prototype._addNotification = function (notification) {
            origAdd.call(this, notification);
            try {
                self._maybeInjectClearBtn(this);
            } catch (e) {
                logError(e, `${LOG_PREFIX} inject clear button failed`);
            }
        };
    }

    _maybeInjectClearBtn(group) {
        const source = group.source;
        if (!this._enabled || !source || !source._ngGroupKey || group._ngClearBtn)
            return;
        const btn = new St.Button({
            style_class: 'message-close-button',
            icon_name: 'window-close-symbolic',
            accessible_name: '清除整组',
        });
        btn.connect('clicked', () => {
            if (!this._enabled)
                return;
            for (const n of [...source.notifications]) {
                if (n.resident)
                    continue;
                try {
                    n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
                } catch {
                    /* already gone */
                }
            }
        });
        try {
            group._headerBox.insert_child_below(btn, group._unexpandButton);
        } catch {
            group._headerBox.add_child(btn);
        }
        group._ngClearBtn = btn;
        this._clearBtns.add(btn);
    }

    // 组配置应用到源（建源与热加载共用同一映射，保证语义一致）
    _applyGroupCfg(source, res) {
        source._ngMode = res.mode;
        source._ngLimit = res.limit;
        source._ngTtlSec = res.ttlSec;
        source._ngDisplayName = res.displayName;
        source._ngIconName = res.iconName;
        source._ngShowCount = res.showCount;
        source._ngCollapseWindowSec = res.collapseWindowSec;
    }

    _enforceHeader(source) {
        try {
            // 首次覆盖前 stash 原值，disable 还原（R8）
            if (source._ngOrigAppName === undefined) {
                source._ngOrigAppName = source._appName;
                source._ngOrigAppIcon = source._appIcon;
            }
            const base = source._ngDisplayName
                || humanizeGroupKey(source._ngGroupKey || '');
            // Fdo 源 title getter = app?.get_name() ?? _appName；
            // 托管源 app 必为 null，直接覆盖 _appName（设计 3）。
            const count = source.notifications.length;
            let name = base;
            if (base.includes('{count}'))
                name = base.replaceAll('{count}', String(count));
            else if (source._ngShowCount)
                name = `${base} (${count})`;
            source._appName = name;
            source.notify('title');
            if (source._ngIconName) {
                source._appIcon = new Gio.ThemedIcon({ name: source._ngIconName });
                source.notify('icon');
            }
        } catch (e) {
            logError(e, `${LOG_PREFIX} enforceHeader failed`);
        }
    }

    _logEnforce(source, what) {
        const id = source._ngGroupKey ? `#${source._ngId}` : '?';
        this._logEvent({
            groupKey: source._ngGroupKey || '?',
            matchedRule: null, derivedFrom: '-', mode: source._ngMode || 'stack',
        }, {
            appName: '-', entry: null, pid: null, title: null,
            src: id, action: what, nid: null,
        });
    }

    // ---- TTL：每源单 timer + 队列（替代每通知一 timer） ----

    _armTtl(source, notification) {
        const ttl = Number.isInteger(source._ngTtlSec) && source._ngTtlSec > 0
            ? source._ngTtlSec
            : 0;
        if (!ttl || !this._enabled)
            return;
        try {
            const q = source._ngTtlQueue ??= [];
            const at = Date.now() + ttl * 1000;
            // replaces 原位更新同一卡：滑动续期而非重复入队（R9）
            const idx = q.findIndex(e => e.n === notification);
            if (idx >= 0)
                q.splice(idx, 1);
            q.push({ n: notification, at }); // 同 ttl 下自然按时间有序
            if (!source._ngTtlTimer)
                this._ttlSchedule(source);
        } catch (e) {
            logError(e, `${LOG_PREFIX} armTtl failed`);
        }
    }

    _ttlSchedule(source) {
        const q = source._ngTtlQueue;
        if (!q || q.length === 0 || !this._enabled || source._inDestruction) {
            source._ngTtlTimer = 0;
            return;
        }
        const delay = Math.max(1, Math.ceil((q[0].at - Date.now()) / 1000));
        const tid = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            source._ngTtlTimer = 0;
            this._ttlTimers.delete(tid);
            this._ttlFire(source);
            return GLib.SOURCE_REMOVE;
        });
        source._ngTtlTimer = tid;
        this._ttlTimers.add(tid);
    }

    _ttlFire(source) {
        const q = source._ngTtlQueue ?? [];
        const now = Date.now();
        const keep = [];
        let fired = 0;
        for (const e of q) {
            // 懒清理：已不在源里的卡（被点掉/被淘汰）直接丢弃，无需 per-卡 connect
            if (!source.notifications.includes(e.n))
                continue;
            if (e.at <= now) {
                try {
                    e.n.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
                    fired++;
                } catch {
                    /* already gone */
                }
            } else {
                keep.push(e);
            }
        }
        source._ngTtlQueue = keep;
        if (fired > 0)
            this._logEnforce(source, `ttl到期×${fired}`);
        if (keep.length > 0)
            this._ttlSchedule(source);
    }

    _ttlDisarm(source) {
        const tid = source._ngTtlTimer;
        if (tid) {
            source._ngTtlTimer = 0;
            if (this._ttlTimers.delete(tid)) {
                try {
                    GLib.source_remove(tid);
                } catch {
                    /* already gone */
                }
            }
        }
        source._ngTtlQueue = [];
    }

    // 规则热加载后，把新表中的 per-group 配置同步到已存在的共享源。
    // groupKey 本身不重算（无原始 title）：删规则的老源按默认配置工作到自然消亡，
    // 新通知按新规则走。启发式组恒 stack。
    // TTL 变更不追溯存量卡：配置变化即 disarm+清空队列（R7：旧配置下的 timer
    // 不得再杀卡），新到卡按新配置重新 arm。
    _reapplyRulesToShared() {
        const groups = (this._rules && this._rules.groups) || {};
        for (const [key, rec] of this._shared) {
            try {
                const cfg = groups[key] ?? {};
                const s = rec.source;
                s._ngMode = rec.derivedFrom === 'heur-rule'
                    ? 'stack'
                    : cfg.mode === 'replace' ? 'replace' : 'stack';
                s._ngLimit = Number.isInteger(cfg.limit) && cfg.limit > 0
                    ? cfg.limit
                    : NATIVE_SOURCE_LIMIT;
                const newTtl = Number.isInteger(cfg.ttlSec) && cfg.ttlSec > 0
                    ? cfg.ttlSec
                    : 0;
                if (newTtl !== s._ngTtlSec)
                    this._ttlDisarm(s);
                s._ngTtlSec = newTtl;
                s._ngCollapseWindowSec =
                    Number.isInteger(cfg.collapseWindowSec) && cfg.collapseWindowSec > 0
                        ? cfg.collapseWindowSec
                        : 0;
                s._ngDisplayName = typeof cfg.displayName === 'string'
                    ? cfg.displayName
                    : null;
                s._ngIconName = typeof cfg.iconName === 'string'
                    ? cfg.iconName
                    : null;
                s._ngShowCount = cfg.showCount === true;
                this._enforceHeader(s);
            } catch (e) {
                logError(e, `${LOG_PREFIX} reapply rules failed for ${key}`);
            }
        }
    }

    // ---- 日志：默认聚合（同 key 5s 窗口合并为计数行），debug 逐行 ----

    _warnOnce(key, msg) {
        if (this._warned.has(key))
            return;
        this._warned.add(key);
        log(`${LOG_PREFIX} WARNING ${msg}`);
    }

    _logEvent(res, ctx) {
        const line = this._formatLine(res, ctx);
        if (this._rules && this._rules.debug) {
            log(line);
            return;
        }
        const key = `${ctx.action}|${res.groupKey}|${ctx.src}`;
        const agg = this._logAgg.get(key);
        if (agg) {
            agg.count++;
            agg.line = line; // 保留最新一行（nid 等信息取最新）
            return;
        }
        this._logAgg.set(key, { count: 1, line });
        log(line); // 首条即记
        if (!this._logFlushTimer) {
            this._logFlushTimer = GLib.timeout_add_seconds(
                GLib.PRIORITY_LOW, LOG_FLUSH_SEC, () => {
                    this._logFlushTimer = 0;
                    for (const [, a] of this._logAgg) {
                        if (a.count > 1)
                            log(`${a.line} ×${a.count}`);
                    }
                    this._logAgg.clear();
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    _formatLine(res, ctx) {
        const rule = res.matchedRule
            ? String(res.matchedRule.pattern)
            : res.derivedFrom === 'heur-rule'
                ? 'heuristic'
                : res.derivedFrom === 'source-rule'
                    ? 'source-rule'
                    : res.derivedFrom === 'blocked'
                        ? 'blocked'
                        : '-';
        let title = '';
        if (this._rules && this._rules.debug && ctx.title) {
            title = ` title=${JSON.stringify(String(ctx.title).slice(0, 80))}`;
        }
        return `${LOG_PREFIX} app=${ctx.appName || '-'} ` +
            `entry=${ctx.entry || '-'} pid=${ctx.pid ?? '-'} ` +
            `rule=${rule} group=${res.groupKey} src=${ctx.src} ` +
            `action=${ctx.action} mode=${res.mode} id=${ctx.nid ?? '-'}${title}`;
    }
}
