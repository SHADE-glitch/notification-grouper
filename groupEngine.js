// groupEngine.js — notification-grouper 通用分组纯函数.
//
// 约束：
// - 无 gi / 无 Shell 依赖，GJS (ESM) 与 Node 可共用同一文件。
// - 引擎内没有任何应用名分支；具体应用只允许出现在 rules 里，且默认 rules.json 为空。
// - 分组键优先级：blockRules(黑名单 veto) > sourceRules(白名单强制合并)
//   > hints[desktop-entry] > appId > 归一化 app_name(非匿名)
//   > 标题前缀规则(可叠加 bodyPattern/urgency) > 标题前缀启发式(内置，可全局开关)
//   > 兜底。
// - 默认 mode = stack（原生堆叠，不丢消息）；replace 仅当 rules.groups 里
//   对该 groupKey 显式声明才生效；启发式组永远 stack。
//
// 性能约定：
// - 扩展层在加载规则时调 compileRules() 一次性 校验+审计+预编译，
//   热路径 computeGroup() 只复用预编译的 rule.re / rule.bodyRe（stateless，
//   无 /g 标志，可安全复用）。直接传未编译规则也能工作（逐条 try 编译兜底），
//   供 node 单测与外部调用方使用。
//
// mergeable 规则（Q1 合并的安全门，扩展层必须遵守）：
// 1. 解析不到 App 且 app_name 有辨识度（非匿名表）：按归一化 app_name 合并。
// 2. 匿名来源：命中用户规则(sourceRules/titlePrefixRules)或内置启发式才合并；
//    否则 mergeable=false，扩展永不合并，各自走原生 per-pid Source。
// 3. blockRules 命中即 veto：mergeable=false，无论来源是否有辨识度。
// 4. 误合并判定示例：两个不同匿名发送者标题都是 "Error: ..." 时，
//    "error" 在通用词停表里，启发式拒绝，双方都进 fallback 且 mergeable=false，
//    原生按 pid 隔离展示——不会合到一起（见单测）。

export const NATIVE_SOURCE_LIMIT = 10;

// 被视为"匿名发送者"的 app_name：这类 key 不能稳定标识来源。
export const ANONYMOUS_APP_NAMES = ['notify-send', 'node-notifier', ''];

// 通用标题词停表：启发式提取到这些词时拒绝成组（避免 "Error: ..." 类误合并）。
// 中英文通用弱辨识度词；多语言可追加，但绝不在此放任何具体应用名。
export const GENERIC_TITLE_WORDS = new Set([
    'error', 'errors', 'warning', 'warnings', 'warn', 'info', 'notice',
    'notification', 'notifications', 'message', 'messages', 'alert', 'alerts',
    'failed', 'failure', 'success', 'successful', 'done', 'update', 'updates',
    'new', '提醒', '通知', '消息', '提示', '警告', '错误', '失败', '成功',
    '完成', '更新', '新消息',
]);

/**
 * 归一化应用标识：小写、去首尾空白、去 .desktop 后缀。
 * @param {string} s
 * @returns {string}
 */
export function normalizeName(s) {
    return String(s ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.desktop$/, '');
}

/**
 * 内置标题前缀启发式（保守版）：只认显式分隔符，不认裸空格。
 * - "[Xxx] ..." 取括号内；
 * - "Xxx: ..." / "Xxx：..." 取冒号前 token（3~40 字符，不含空白）。
 * 命中停表词、纯数字符号、过短均返回 null。
 * @param {string} title
 * @returns {string|null} 归一化后的候选分组名，未命中返回 null
 */
export function heuristicPrefix(title) {
    const t = String(title ?? '');
    let m = t.match(/^\s*\[([^\[\]]{2,40})\]/);
    let cand = m ? m[1] : null;
    if (!cand) {
        m = t.match(/^\s*([^:\s:：\[\]\(\)（）]{3,40})\s*[:：]/);
        cand = m ? m[1] : null;
    }
    if (!cand)
        return null;
    cand = cand.trim();
    const norm = cand.toLowerCase();
    if (GENERIC_TITLE_WORDS.has(norm))
        return null;
    if (/^[0-9\W_]+$/.test(cand))
        return null;
    if (norm.length < 3)
        return null;
    return norm;
}

/**
 * groupKey 转可读显示名（无规则 displayName 时的回退）。
 * @param {string} groupKey
 * @returns {string}
 */
export function humanizeGroupKey(groupKey) {
    const body = groupKey.includes(':') ? groupKey.slice(groupKey.indexOf(':') + 1) : groupKey;
    return body.replace(/[-_]+/g, ' ').trim() || groupKey;
}

/**
 * urgency 归一化：0/1/2 或 'low'/'normal'/'critical' -> 0/1/2；其余 -> null。
 * @param {number|string|null|undefined} v
 * @returns {number|null}
 */
export function normalizeUrgency(v) {
    if (v === 0 || v === 1 || v === 2)
        return v;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'low')
            return 0;
        if (s === 'normal')
            return 1;
        if (s === 'critical')
            return 2;
    }
    return null;
}

/**
 * @typedef {object} NotifyInput
 * @property {string} [appName]      FDO Notify 第一个参数
 * @property {string} [desktopEntry] hints['desktop-entry']（unpacked 后）
 * @property {string} [appId]        预留：portal/Gtk 路径的应用 id（FDO 路径一般无）
 * @property {string} [sender]       D-Bus 发送者（如 :1.151，仅兜底参考）
 * @property {number} [senderPid]    x-shell-sender-pid / sender-pid
 * @property {string} [title]        通知标题（仅用于标题前缀规则/启发式匹配）
 * @property {string} [body]         通知正文（仅用于规则的 bodyPattern 匹配；扩展层永不记录）
 * @property {number|string} [urgency] 0/1/2 或 low/normal/critical（仅用于规则的 urgency 过滤）
 *
 * @typedef {object} Rules
 * @property {Array<{pattern: string, group: string, bodyPattern?: string, urgency?: number|string}>} [titlePrefixRules]
 * @property {Array<{appName?: string, desktopEntry?: string, appId?: string, group: string}>} [sourceRules]
 *   白名单：归一化精确匹配（多字段 AND），命中即强制合并到指定组（匿名来源也可）。
 * @property {Array<{appName?: string, desktopEntry?: string, appId?: string, titlePattern?: string}>} [blockRules]
 *   黑名单：命中即 mergeable=false，永不合并，走原生 per-pid。优先级最高。
 * @property {Record<string, {mode?: 'stack'|'replace', limit?: number, displayName?: string, ttlSec?: number, ignoreReplaces?: boolean, iconName?: string, showCount?: boolean, collapseWindowSec?: number}>} [groups]
 * @property {boolean} [heuristicTitlePrefix] 内置启发式总开关，默认 true
 *
 * @typedef {object} GroupResult
 * @property {string} groupKey
 * @property {string} derivedFrom  'blocked' | 'source-rule' | 'desktop-entry' | 'app-id'
 *   | 'app-name' | 'title-rule' | 'heur-rule' | 'fallback'
 * @property {object|null} matchedRule 命中的标题规则，未命中为 null
 * @property {boolean} isFallback
 * @property {boolean} mergeable   该组是否允许落入同一共享 Source
 * @property {'stack'|'replace'} mode  默认 stack；replace 仅显式配置；启发式组恒为 stack
 * @property {number} limit 每组上限，默认 NATIVE_SOURCE_LIMIT(10，原生值)
 * @property {string|null} displayName 规则 displayName，直通给组头显示（支持 {count} 占位）
 * @property {number} ttlSec 组内存活秒数，0=关闭；仅 rules.groups 显式配置
 * @property {boolean} ignoreReplaces 是否剥离发送方 replaces_id（每事件强制新卡）；
 *   仅 rules.groups 显式 true；默认 false（尊重发送方原位更新语义）
 * @property {string|null} iconName 规则 iconName（主题图标名），未配置为 null（原生图标回退）
 * @property {boolean} showCount 组头是否显示组内计数（displayName 无 {count} 时追加 " (N)"）
 * @property {number} collapseWindowSec 时间窗口折叠：窗口内同组新卡顶替上一张（先加后删）。
 *   会丢窗口内的旧卡，仅显式配置 >0 生效；默认 0=关闭
 */

function safeCompile(pattern) {
    try {
        return new RegExp(pattern);
    } catch {
        return null;
    }
}

// 规则里声明的 id 字段全部相等（AND）才算命中；调用方保证至少声明一个字段。
function matchIds(rule, ids) {
    if (rule.appName != null && rule.appName !== ids.appName)
        return false;
    if (rule.desktopEntry != null && rule.desktopEntry !== ids.desktopEntry)
        return false;
    if (rule.appId != null && rule.appId !== ids.appId)
        return false;
    return true;
}

/**
 * 计算分组。
 * @param {NotifyInput} input
 * @param {Rules} [rules]
 * @returns {GroupResult}
 */
export function computeGroup(input, rules = {}) {
    const titlePrefixRules = rules.titlePrefixRules ?? [];
    const sourceRules = rules.sourceRules ?? [];
    const blockRules = rules.blockRules ?? [];
    const groups = rules.groups ?? {};

    const desktopEntry = normalizeName(input.desktopEntry);
    const appId = normalizeName(input.appId);
    const appName = normalizeName(input.appName);
    const title = String(input.title ?? '');
    const body = String(input.body ?? '');
    const urgency = normalizeUrgency(input.urgency);
    const ids = { appName, desktopEntry, appId };

    // 黑名单 veto（最高优先）：命中即不可合并，走原生 per-pid 隔离。
    for (const rule of blockRules) {
        if (rule.titleRe) {
            if (!rule.titleRe.test(title))
                continue;
            // titlePattern 单独成规则，或与 id 字段 AND
            if ((rule.appName != null || rule.desktopEntry != null || rule.appId != null) &&
                !matchIds(rule, ids))
                continue;
        } else if (!matchIds(rule, ids)) {
            continue;
        }
        const name = desktopEntry || appId || appName || 'anonymous';
        return finish(`fallback:${name}`, 'blocked', null, false, groups, false);
    }

    // 白名单强制合并：显式规则优先于自动 identity 链（可把多个来源并进一组）。
    for (const rule of sourceRules) {
        if (matchIds(rule, ids))
            return finish(`app:${rule.group}`, 'source-rule', null, true, groups, false);
    }

    if (desktopEntry)
        return finish(`app:${desktopEntry}`, 'desktop-entry', null, true, groups, false);

    if (appId)
        return finish(`app:${appId}`, 'app-id', null, true, groups, false);

    const isAnonymous = !appName || ANONYMOUS_APP_NAMES.includes(appName);
    if (!isAnonymous)
        return finish(`app:${appName}`, 'app-name', null, true, groups, false);

    // 匿名来源：先查用户标题前缀规则表（可叠加 bodyPattern / urgency 过滤）。
    for (const rule of titlePrefixRules) {
        const re = rule.re ?? safeCompile(rule.pattern);
        if (!re)
            continue; // 非法正则直接跳过，不炸整条通知
        if (!re.test(title))
            continue;
        if (rule.bodyRe && !rule.bodyRe.test(body))
            continue;
        if (rule.urgency != null && rule.urgency !== urgency)
            continue;
        return finish(`app:${normalizeName(rule.group)}`, 'title-rule', rule, true, groups, false);
    }

    // 内置启发式（可全局关闭；产生的组恒为 stack）。
    if (rules.heuristicTitlePrefix !== false) {
        const heur = heuristicPrefix(title);
        if (heur)
            return finish(`heur:${heur}`, 'heur-rule', null, true, groups, true);
    }

    // 兜底：按匿名 app 名区分，不可合并（不同发送者天然隔离，各自走原生 Source）。
    const fallbackName = appName || 'anonymous';
    return finish(`fallback:${fallbackName}`, 'fallback', null, false, groups, false);
}

/**
 * 挂接点自检（纯函数，供扩展 enable 自降级与单测共用）。
 * 任一补丁点不存在 -> attach=false，扩展只记一条警告并整体不生效，
 * 不抛错、不半挂载。
 * @param {object} [info]
 * @param {boolean} [info.hasFdo]
 * @param {string} [info.fdoKeys] 诊断用：实际看到的属性名
 * @param {boolean} [info.hasNotifyAsync]
 * @param {boolean} [info.hasGetSource]
 * @param {boolean} [info.hasFdoSourceClass]
 * @param {boolean} [info.hasProcessNotification]
 * @returns {{attach: boolean, warnings: string[], patches: string[]}}
 */
export const REQUIRED_PATCHES = [
    'NotifyAsync',
    '_getSourceForPidAndName',
    'processNotification',
];

export function checkAttachPoints(info = {}) {
    const warnings = [];
    if (!info.hasFdo) {
        warnings.push(
            `_fdoNotificationDaemon unreachable [${info.fdoKeys ?? 'unknown'}]`);
    } else {
        if (!info.hasNotifyAsync)
            warnings.push('NotifyAsync missing on FDO instance');
        if (!info.hasGetSource)
            warnings.push('_getSourceForPidAndName missing on FDO instance');
    }
    if (!info.hasFdoSourceClass) {
        warnings.push('FdoNotificationDaemonSource not exported');
    } else if (!info.hasProcessNotification) {
        warnings.push('processNotification missing on FDO source prototype');
    }
    if (warnings.length > 0)
        return { attach: false, warnings, patches: [] };
    return { attach: true, warnings, patches: [...REQUIRED_PATCHES] };
}

/**
 * 标题规则审计（ReDoS 防护，纯函数）。
 * 背景：规则在 Shell 主线程同步执行，灾难回溯 pattern（如 `^(a+)+$`）
 * 一条匿名通知即可冻住整个桌面。审计在规则加载时跑一次（低频），
 * 不在每通知路径上。
 * 三层筛查：编译失败 -> 拒；嵌套量词静态形状 -> 拒；
 * 对抗输入计时探测（22 字符，预算内）超限 -> 拒。
 * 探测本身有界：evil 形状在 22 字符即爆炸（~几十 ms 内可判定），
 * 安全 pattern 为微秒级，单次加载总成本可控。
 */
export const RULE_AUDIT_BUDGET_MS = 50;
const NESTED_QUANTIFIER_RE = /(\([^()]*[+*][^()]*\)[+*?]|\{[^}]*\}[+*?])/;
const AUDIT_PROBES = ['a'.repeat(22) + '!', ' '.repeat(22) + '!'];

// 单 pattern 审计：通过返回预编译 RegExp，被拒返回原因串。
function auditPattern(pattern) {
    if (typeof pattern !== 'string')
        return { re: null, reason: 'not-a-string' };
    let re;
    try {
        re = new RegExp(pattern);
    } catch {
        return { re: null, reason: 'compile-error' };
    }
    if (NESTED_QUANTIFIER_RE.test(pattern))
        return { re: null, reason: 'risky-nested-quantifier' };
    const t0 = Date.now();
    try {
        for (const probe of AUDIT_PROBES)
            re.test(probe);
    } catch {
        return { re: null, reason: 'probe-error' };
    }
    const cost = Date.now() - t0;
    if (cost > RULE_AUDIT_BUDGET_MS)
        return { re: null, reason: `slow-probe(${cost}ms)` };
    return { re, reason: null };
}

/**
 * @param {Array} titlePrefixRules
 * @returns {{safe: Array, rejected: Array<{pattern: string, group: string, reason: string}>}}
 */
export function auditTitleRules(titlePrefixRules) {
    const safe = [];
    const rejected = [];
    if (!Array.isArray(titlePrefixRules))
        return { safe, rejected };
    for (const rule of titlePrefixRules) {
        const { re, reason } = auditPattern(rule && rule.pattern);
        if (reason)
            rejected.push({ pattern: String(rule && rule.pattern), group: rule && rule.group, reason });
        else
            safe.push(rule);
    }
    return { safe, rejected };
}

/**
 * 规则编译+校验（加载时一次性；扩展层与 prefs 共用同一入口）。
 * - 所有 pattern 经 ReDoS 审计并预编译，危险/非法直接拒载不进热路径；
 * - schema 错误（字段类型错、缺必填）逐条记入 errors，该条目被丢弃，
 *   其余条目照常生效（粗粒度回滚由调用方决定：JSON 解析失败时整体沿用旧规则）；
 * - 返回的 rules 可直接传给 computeGroup 热路径（预编译 re 复用，零 per-notify 编译）。
 * @param {object} raw JSON.parse 后的原始规则
 * @returns {{rules: Rules, errors: Array<{where: string, reason: string}>,
 *   rejected: Array<{where: string, pattern: string, reason: string}>}}
 */
export function compileRules(raw = {}) {
    const errors = [];
    const rejected = [];
    const out = {
        titlePrefixRules: [],
        sourceRules: [],
        blockRules: [],
        groups: {},
        heuristicTitlePrefix: raw && raw.heuristicTitlePrefix !== false,
        debug: !!(raw && raw.debug === true),
    };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push({ where: 'root', reason: 'not-an-object' });
        return { rules: out, errors, rejected };
    }

    // ---- titlePrefixRules：pattern 必填 + bodyPattern/urgency 可选 ----
    if (raw.titlePrefixRules != null) {
        if (!Array.isArray(raw.titlePrefixRules)) {
            errors.push({ where: 'titlePrefixRules', reason: 'not-an-array' });
        } else {
            raw.titlePrefixRules.forEach((r, i) => {
                const where = `titlePrefixRules[${i}]`;
                if (!r || typeof r !== 'object') {
                    errors.push({ where, reason: 'not-an-object' });
                    return;
                }
                const { re, reason } = auditPattern(r.pattern);
                if (reason) {
                    rejected.push({ where, pattern: String(r.pattern), reason });
                    return;
                }
                if (typeof r.group !== 'string' || !r.group.trim()) {
                    errors.push({ where, reason: 'group-missing' });
                    return;
                }
                let bodyRe = null;
                if (r.bodyPattern != null) {
                    const b = auditPattern(r.bodyPattern);
                    if (b.reason) {
                        rejected.push({ where: `${where}.bodyPattern`, pattern: String(r.bodyPattern), reason: b.reason });
                        return;
                    }
                    bodyRe = b.re;
                }
                let urgency = null;
                if (r.urgency != null) {
                    urgency = normalizeUrgency(r.urgency);
                    if (urgency == null) {
                        errors.push({ where: `${where}.urgency`, reason: 'bad-urgency(ignored)' });
                    }
                }
                const entry = {
                    pattern: r.pattern, group: r.group, re, bodyRe, urgency,
                };
                if (typeof r.comment === 'string')
                    entry.comment = r.comment;
                out.titlePrefixRules.push(entry);
            });
        }
    }

    // ---- sourceRules（白名单）：至少一个 id 字段 + group ----
    if (raw.sourceRules != null) {
        if (!Array.isArray(raw.sourceRules)) {
            errors.push({ where: 'sourceRules', reason: 'not-an-array' });
        } else {
            raw.sourceRules.forEach((r, i) => {
                const where = `sourceRules[${i}]`;
                const entry = compileIdRule(r, where, errors);
                if (!entry)
                    return;
                if (typeof r.group !== 'string' || !r.group.trim()) {
                    errors.push({ where, reason: 'group-missing' });
                    return;
                }
                entry.group = normalizeName(r.group);
                out.sourceRules.push(entry);
            });
        }
    }

    // ---- blockRules（黑名单）：至少一个 id 字段或 titlePattern ----
    if (raw.blockRules != null) {
        if (!Array.isArray(raw.blockRules)) {
            errors.push({ where: 'blockRules', reason: 'not-an-array' });
        } else {
            raw.blockRules.forEach((r, i) => {
                const where = `blockRules[${i}]`;
                const entry = compileIdRule(r, where, errors);
                if (!entry && !(r && typeof r.titlePattern === 'string')) {
                    if (!errors.some(e => e.where === where))
                        errors.push({ where, reason: 'no-match-field' });
                    return;
                }
                const rec = entry ?? {};
                if (r && r.titlePattern != null) {
                    const t = auditPattern(r.titlePattern);
                    if (t.reason) {
                        rejected.push({ where: `${where}.titlePattern`, pattern: String(r.titlePattern), reason: t.reason });
                        return;
                    }
                    rec.titlePattern = r.titlePattern;
                    rec.titleRe = t.re;
                }
                if (!rec.appName && !rec.desktopEntry && !rec.appId && !rec.titleRe) {
                    errors.push({ where, reason: 'no-match-field' });
                    return;
                }
                out.blockRules.push(rec);
            });
        }
    }

    // ---- groups：逐字段类型校验，非法字段丢弃回默认 ----
    if (raw.groups != null) {
        if (typeof raw.groups !== 'object' || Array.isArray(raw.groups)) {
            errors.push({ where: 'groups', reason: 'not-an-object' });
        } else {
            for (const [key, cfg] of Object.entries(raw.groups)) {
                if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
                    errors.push({ where: `groups.${key}`, reason: 'not-an-object' });
                    continue;
                }
                out.groups[key] = checkGroupCfg(key, cfg, errors);
            }
        }
    }

    return { rules: out, errors, rejected };
}

// sourceRules/blockRules 共用：提取并归一化 id 匹配字段；全缺返回 null。
function compileIdRule(r, where, errors) {
    if (!r || typeof r !== 'object') {
        errors.push({ where, reason: 'not-an-object' });
        return null;
    }
    const rec = {};
    for (const f of ['appName', 'desktopEntry', 'appId']) {
        if (r[f] == null)
            continue;
        if (typeof r[f] !== 'string' || !r[f].trim()) {
            errors.push({ where: `${where}.${f}`, reason: 'bad-value' });
            continue;
        }
        rec[f] = normalizeName(r[f]);
    }
    if (typeof r.comment === 'string')
        rec.comment = r.comment;
    if (rec.appName == null && rec.desktopEntry == null && rec.appId == null)
        return null;
    return rec;
}

const GROUP_INT_FIELDS = ['limit', 'ttlSec', 'collapseWindowSec'];
const GROUP_STR_FIELDS = ['displayName', 'iconName', 'comment'];
const GROUP_BOOL_FIELDS = ['ignoreReplaces', 'showCount'];

function checkGroupCfg(key, cfg, errors) {
    const out = {};
    const where = `groups.${key}`;
    if (cfg.mode != null) {
        if (cfg.mode === 'stack' || cfg.mode === 'replace')
            out.mode = cfg.mode;
        else
            errors.push({ where: `${where}.mode`, reason: 'bad-mode(ignored)' });
    }
    for (const f of GROUP_INT_FIELDS) {
        if (cfg[f] == null)
            continue;
        if (Number.isInteger(cfg[f]) && cfg[f] >= 0 && (f !== 'limit' || cfg[f] > 0))
            out[f] = cfg[f];
        else
            errors.push({ where: `${where}.${f}`, reason: 'bad-int(ignored)' });
    }
    for (const f of GROUP_STR_FIELDS) {
        if (cfg[f] == null)
            continue;
        if (typeof cfg[f] === 'string')
            out[f] = cfg[f];
        else
            errors.push({ where: `${where}.${f}`, reason: 'bad-string(ignored)' });
    }
    for (const f of GROUP_BOOL_FIELDS) {
        if (cfg[f] == null)
            continue;
        if (typeof cfg[f] === 'boolean')
            out[f] = cfg[f];
        else
            errors.push({ where: `${where}.${f}`, reason: 'bad-bool(ignored)' });
    }
    return out;
}

function finish(groupKey, derivedFrom, matchedRule, mergeable, groups, forceStack) {
    const cfg = groups[groupKey] ?? {};
    const mode = !forceStack && cfg.mode === 'replace' ? 'replace' : 'stack';
    const limit =
        Number.isInteger(cfg.limit) && cfg.limit > 0
            ? cfg.limit
            : NATIVE_SOURCE_LIMIT;
    const ttlSec =
        Number.isInteger(cfg.ttlSec) && cfg.ttlSec > 0 ? cfg.ttlSec : 0;
    const collapseWindowSec =
        Number.isInteger(cfg.collapseWindowSec) && cfg.collapseWindowSec > 0
            ? cfg.collapseWindowSec
            : 0;
    return {
        ignoreReplaces: cfg.ignoreReplaces === true,
        groupKey,
        derivedFrom,
        matchedRule,
        isFallback: derivedFrom === 'fallback',
        mergeable,
        mode,
        limit,
        displayName: typeof cfg.displayName === 'string' ? cfg.displayName : null,
        ttlSec,
        iconName: typeof cfg.iconName === 'string' ? cfg.iconName : null,
        showCount: cfg.showCount === true,
        collapseWindowSec,
    };
}
