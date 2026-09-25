// notification-grouper@local — 通用通知分组扩展（GNOME 50）。
//
// 设计（Q1 选 c，只改 FDO 实例的 Source 缓存键推导，不改替换语义）：
//  1. groupKey 传递：在实例 NotifyAsync 包裹层先调 computeGroup()（纯函数，
//     见 groupEngine.js），结果暂存闭包，_getSourceForPidAndName 包裹层消费。
//     50.1 源码核对：NotifyAsync 为同步方法（notificationDaemon.js:135），
//     从入口到 Source 查找（:169-174）之间无任何 await，整文件无 async——
//     try/finally 暂存安全（JS 单线程 + D-Bus 同步派发，无重入）。
//     若 Ubuntu 补丁引入 await，此假设失效，日志会显示 groupKey 错位，L2 核对。
//  2. 覆盖范围：所有解析不到 App 的来源（_getSourceForPidAndName 路径），
//     不只是 notify-send——Code-Notify / opencode（有 app_name、无 App）同样
//     每次新 pid 建新 Source，一并按 mergeable 的 groupKey 合并。
//     已解析到 source.app 的走 _getSourceForApp，原生已按 App 成栈，默认不碰。
//     Gtk 路径（_gtkNotificationDaemon / GtkNotificationDaemonAppSource）
//     是另一个独立对象与类，本扩展不引用不 patch。
//  3. 组头显示：共享 Source 在 processNotification 包裹层（仅 _ngGroupKey
//     标记的源生效）于原逻辑之后强制覆盖 _appName 为 displayName（规则显式
//     displayName 优先，否则 humanizeGroupKey），不沿用首条 app_name。
//     图标沿用原生回退（首条通知的 appIcon，last-write-wins），MVP 不定制。
//     只改 Shell 侧对象，不改总线载荷（ide-notify-sound 回归安全）。
//  4. 生命周期：共享 Source 建时连 'destroy' 自清缓存；replace 模式先加新卡
//     再销毁旧卡（避免源被清空自毁）；disable 还原三处补丁、断开文件监视、
//     清空缓存（存活通知继续原生工作，不强制销毁用户通知）。
//
// 点击语义：托管源实例 open() 遮蔽为 no-op，点击 = 仅关闭被点单卡。
// 日志：每条 Notify 一行，前缀 [notification-grouper]；永不记 body；
// title 仅 rules.debug=true 时记（默认 false）。

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { computeGroup, humanizeGroupKey, checkAttachPoints, auditTitleRules, NATIVE_SOURCE_LIMIT } from './groupEngine.js';

const LOG_PREFIX = '[notification-grouper]';

export default class NotificationGrouperExtension extends Extension {
    _enabled = false;
    _rules = null;
    _rulesMonitor = null;
    _rulesMonitorId = 0;
    /** groupKey -> {source, id, derivedFrom} */
    _shared = new Map();
    /** 存活的 TTL 定时器 id（disable 时全部清除） */
    _ttlTimers = new Set();
    _sourceSeq = 0;
    /** 当前同步调用中的 computeGroup 结果（见文件头设计 1） */
    _pending = null;
    _orig = null;
    _FdoSrc = null;
    _appliedPatches = [];

    enable() {
        this._enabled = true;
        this._shared = new Map();
        this._sourceSeq = 0;
        this._pending = null;
        this._loadRules();
        this._watchRules();
        log(`${LOG_PREFIX} enabled, loading FDO daemon module…`);
        import('resource:///org/gnome/shell/ui/notificationDaemon.js').then(
            mod => {
                if (!this._enabled)
                    return; // enable 后 disable 又发生在模块返回前
                try {
                    this._attach(mod);
                } catch (e) {
                    logError(e, `${LOG_PREFIX} attach failed, staying inert`);
                }
            }
        ).catch(e => {
            logError(e, `${LOG_PREFIX} cannot import notificationDaemon module`);
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
        }
        for (const tid of this._ttlTimers) {
            try {
                GLib.source_remove(tid);
            } catch {
                /* best effort */
            }
        }
        this._ttlTimers.clear();
        this._orig = null;
        this._FdoSrc = null;
        const restored = this._appliedPatches;
        this._appliedPatches = [];
        for (const [, rec] of this._shared) {
            try {
                delete rec.source.open;
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

    _defaultRules() {
        return {
            titlePrefixRules: [],
            groups: {},
            heuristicTitlePrefix: true,
            debug: false,
        };
    }

    _loadRules() {
        try {
            const file = Gio.File.new_for_path(this._rulesPath);
            const [ok, bytes] = file.load_contents(null);
            if (!ok)
                throw new Error('load_contents failed');
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            const next = this._defaultRules();
            if (Array.isArray(parsed.titlePrefixRules)) {
                // ReDoS 防护：拒载危险 pattern，只记单行警告（不清堆栈刷屏）。
                const audit = auditTitleRules(parsed.titlePrefixRules);
                next.titlePrefixRules = audit.safe;
                for (const r of audit.rejected) {
                    log(`${LOG_PREFIX} rules reject pattern=${JSON.stringify(r.pattern)} ` +
                        `reason=${r.reason} (stays unloaded)`);
                }
            }
            if (parsed.groups && typeof parsed.groups === 'object')
                next.groups = parsed.groups;
            if (parsed.heuristicTitlePrefix === false)
                next.heuristicTitlePrefix = false;
            if (parsed.debug === true)
                next.debug = true;
            this._rules = next;
            log(`${LOG_PREFIX} rules loaded: ${next.titlePrefixRules.length} title rules, ` +
                `${Object.keys(next.groups).length} groups, ` +
                `heuristic=${next.heuristicTitlePrefix}, debug=${next.debug}`);
            this._reapplyRulesToShared();
        } catch (e) {
            if (!this._rules)
                this._rules = this._defaultRules();
            // 坏文件只记单行（不刷堆栈），沿用旧规则继续工作。
            log(`${LOG_PREFIX} rules load failed, keeping previous: ${e && e.message ? e.message : e}`);
        }
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

    _attach(mod) {
        // 自降级：任一补丁点不存在只记一条警告并整体不生效（不抛错、不半挂载）。
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
        };

        const self = this;

        fdo.NotifyAsync = function (params, invocation) {
            // FDO Notify 参数位：0 app_name, 1 replaces_id, 2 app_icon,
            // 3 summary, 4 body, 5 actions, 6 hints, 7 timeout。
            // 注意：入口处 hints 内仍是 GLib.Variant，需 deepUnpack。
            let entry = null;
            try {
                const v = params[6] ? params[6]['desktop-entry'] : null;
                if (v)
                    entry = v.deepUnpack();
            } catch {
                entry = null;
            }
            let senderPid = null;
            try {
                const v = params[6] ? params[6]['x-shell-sender-pid'] : null;
                if (v)
                    senderPid = v.deepUnpack();
            } catch {
                senderPid = null;
            }
            const res = computeGroup({
                appName: params[0],
                desktopEntry: entry,
                title: params[3],
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
            // 走复用分支（不经过 _getSource，暂存无影响）；Shell 不认识（stale id，
            // 如发送方 lastId 残留）则落 else 分支，_getSource 用暂存合并。
            // L2 实测：stale id 未置位时会退回每 pid 一源，故必须全置。
            self._pending = res;
            if (stripped) {
                self._logLine(res, {
                    appName: params[0], entry, pid: senderPid,
                    title: params[3], src: '?', action: 'replaces已剥离(规则强制新卡)',
                    nid: null,
                });
            }
            if (params[1] !== 0) {
                try {
                    const ret = self._orig.notify.call(this, params, invocation);
                    // Shell 认识该 id：orig 直接复用旧卡（不经过 _getSource）。
                    // 查旧卡归属补一行；不认识（stale）则已走 else 分支，
                    // _getSource 包裹层打过行，这里不再重复。
                    try {
                        const n = self._orig.fdo._notifications.get(params[1]);
                        if (n) {
                            let src = 'native';
                            let action = 'replaces复用原生源';
                            for (const [, r] of self._shared) {
                                if (r.source === n.source) {
                                    src = `#${r.id}`;
                                    action = `replaces复用共享源#${r.id}`;
                                    break;
                                }
                            }
                            self._logLine(res, {
                                appName: params[0], entry, pid: senderPid,
                                title: params[3], src, action, nid: params[1],
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
            const res = self._pending;
            let nid = null;
            try {
                nid = self._orig.fdo._nextNotificationId - 1;
            } catch {
                nid = null;
            }
            if (!res || !res.mergeable) {
                if (res) {
                    self._logLine(res, {
                        appName, entry: null, pid, title: null,
                        src: 'native', action: '原生直通', nid,
                    });
                }
                return self._orig.getSource.call(this, sender, pid, appName);
            }
            const key = res.groupKey;
            const rec = self._shared.get(key);
            if (rec) {
                self._logLine(res, {
                    appName, entry: null, pid, title: null,
                    src: `#${rec.id}`, action: `复用共享源#${rec.id}`, nid,
                });
                return rec.source;
            }
            const source = self._orig.getSource.call(this, sender, pid, appName);
            const id = ++self._sourceSeq;
            source._ngGroupKey = key;
            source._ngId = id;
            source._ngMode = res.mode;
            source._ngDisplayName = res.displayName;
            source._ngLimit = res.limit;
            source._ngTtlSec = res.ttlSec;
            // 点击语义：托管源（匿名，无 App）的 open() 原本会 destroyNonResidentNotifications，
            // 点 1 张卡则同组全灭 + 横幅状态机竞争（L3 A/B 定罪的"点击卡住"）。
            // 改为 no-op 后点击 = 仅关闭被点单卡（activate 自毁本卡），兄弟卡与总览不受影响。
            // 仅实例级遮蔽，不碰原型与 Gtk/原生源。
            source.open = function () {
            };
            source.connect('destroy', () => {
                const cur = self._shared.get(key);
                if (cur && cur.source === source)
                    self._shared.delete(key);
            });
            self._shared.set(key, { source, id, derivedFrom: res.derivedFrom });
            self._logLine(res, {
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
            // Step 4：每组上限（原生 10 为兜底；规则 limit 更小时在此强制）。
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
            // Step 4：TTL（仅规则显式 ttlSec>0 的组）。
            self._armTtl(this, notification);
            self._enforceHeader(this);
        };

        this._appliedPatches = check.patches;
        log(`${LOG_PREFIX} enabled, attached patches: ${check.patches.join(', ')} (Q1-c key-derivation)`);
    }

    _enforceHeader(source) {
        try {
            const name = source._ngDisplayName
                || humanizeGroupKey(source._ngGroupKey || '');
            // Fdo 源 title getter = app?.get_name() ?? _appName；
            // 托管源 app 必为 null，直接覆盖 _appName（设计 3）。
            source._appName = name;
            source.notify('title');
        } catch (e) {
            logError(e, `${LOG_PREFIX} enforceHeader failed`);
        }
    }

    _logEnforce(source, what) {
        let id = '?';
        try {
            for (const [, r] of this._shared) {
                if (r.source === source) {
                    id = `#${r.id}`;
                    break;
                }
            }
        } catch {
            /* best effort */
        }
        log(`${LOG_PREFIX} enforce group=${source._ngGroupKey || '?'} ` +
            `src=${id} action=${what}`);
    }

    _armTtl(source, notification) {
        const ttl = Number.isInteger(source._ngTtlSec) && source._ngTtlSec > 0
            ? source._ngTtlSec
            : 0;
        if (!ttl || !this._enabled)
            return;
        try {
            const tid = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, ttl, () => {
                    this._ttlTimers.delete(tid);
                    // 先记 id 再销毁：销毁会同步清空源并摘缓存（src=? 即此因）。
                    let id = '?';
                    try {
                        for (const [, r] of this._shared) {
                            if (r.source === source) {
                                id = `#${r.id}`;
                                break;
                            }
                        }
                    } catch {
                        /* best effort */
                    }
                    try {
                        notification.destroy(
                            MessageTray.NotificationDestroyedReason.EXPIRED);
                    } catch {
                        /* already gone */
                    }
                    log(`${LOG_PREFIX} enforce group=${source._ngGroupKey || '?'} ` +
                        `src=${id} action=ttl到期(${ttl}s)`);
                    return GLib.SOURCE_REMOVE;
                });
            this._ttlTimers.add(tid);
            notification.connect('destroy', () => {
                if (this._ttlTimers.delete(tid)) {
                    try {
                        GLib.source_remove(tid);
                    } catch {
                        /* already gone */
                    }
                }
            });
        } catch (e) {
            logError(e, `${LOG_PREFIX} armTtl failed`);
        }
    }

    // 规则热加载后，把新表中的 per-group 配置同步到已存在的共享源。
    // groupKey 本身不重算（无原始 title）：删规则的老源按默认配置工作到自然消亡，
    // 新通知按新规则走。启发式组恒 stack。
    _reapplyRulesToShared() {
        const groups = (this._rules && this._rules.groups) || {};
        for (const [key, rec] of this._shared) {
            try {
                const cfg = groups[key] ?? {};
                rec.source._ngMode = rec.derivedFrom === 'heur-rule'
                    ? 'stack'
                    : cfg.mode === 'replace' ? 'replace' : 'stack';
                rec.source._ngLimit = Number.isInteger(cfg.limit) && cfg.limit > 0
                    ? cfg.limit
                    : NATIVE_SOURCE_LIMIT;
                rec.source._ngTtlSec = Number.isInteger(cfg.ttlSec) && cfg.ttlSec > 0
                    ? cfg.ttlSec
                    : 0;
                rec.source._ngDisplayName = typeof cfg.displayName === 'string'
                    ? cfg.displayName
                    : null;
                this._enforceHeader(rec.source);
            } catch (e) {
                logError(e, `${LOG_PREFIX} reapply rules failed for ${key}`);
            }
        }
    }

    _logLine(res, ctx) {
        const rule = res.matchedRule
            ? String(res.matchedRule.pattern)
            : res.derivedFrom === 'heur-rule'
                ? 'heuristic'
                : '-';
        let title = '';
        if (this._rules && this._rules.debug && ctx.title) {
            title = ` title=${JSON.stringify(String(ctx.title).slice(0, 80))}`;
        }
        log(`${LOG_PREFIX} app=${ctx.appName || '-'} ` +
            `entry=${ctx.entry || '-'} pid=${ctx.pid ?? '-'} ` +
            `rule=${rule} group=${res.groupKey} src=${ctx.src} ` +
            `action=${ctx.action} mode=${res.mode} id=${ctx.nid ?? '-'}${title}`);
    }
}
