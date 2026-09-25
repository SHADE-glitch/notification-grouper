// groupEngine.js — notification-grouper 通用分组纯函数.
//
// 约束：
// - 无 gi / 无 Shell 依赖，GJS (ESM) 与 Node 可共用同一文件。
// - 引擎内没有任何应用名分支；具体应用只允许出现在 rules (titlePrefixRules /
//   groups) 里，且默认 rules.json 为空。
// - 分组键优先级：hints[desktop-entry] > appId > 归一化 app_name(非匿名)
//   > 标题前缀规则(用户配置) > 标题前缀启发式(内置，可全局开关)
//   > 兜底。
// - 默认 mode = stack（原生堆叠，不丢消息）；replace 仅当 rules.groups 里
//   对该 groupKey 显式声明才生效；启发式组永远 stack。
//
// mergeable 规则（Q1 合并的安全门，扩展层必须遵守）：
// 1. 解析不到 App 且 app_name 有辨识度（非匿名表）：按归一化 app_name 合并。
// 2. 匿名来源：命中用户规则或内置启发式才合并（mergeable=true）；
//    否则 mergeable=false，扩展永不合并，各自走原生 per-pid Source。
// 3. 误合并判定示例：两个不同匿名发送者标题都是 "Error: ..." 时，
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
 * @typedef {object} NotifyInput
 * @property {string} [appName]      FDO Notify 第一个参数
 * @property {string} [desktopEntry] hints['desktop-entry']（unpacked 后）
 * @property {string} [appId]        预留：portal/Gtk 路径的应用 id（FDO 路径一般无）
 * @property {string} [sender]       D-Bus 发送者（如 :1.151，仅兜底参考）
 * @property {number} [senderPid]    x-shell-sender-pid / sender-pid
 * @property {string} [title]        通知标题（仅用于标题前缀规则/启发式匹配）
 *
 * @typedef {object} Rules
 * @property {Array<{pattern: string, group: string}>} [titlePrefixRules]
 * @property {Record<string, {mode?: 'stack'|'replace', limit?: number, displayName?: string, ttlSec?: number, ignoreReplaces?: boolean}>} [groups]
 * @property {boolean} [heuristicTitlePrefix] 内置启发式总开关，默认 true
 *
 * @typedef {object} GroupResult
 * @property {string} groupKey
 * @property {string} derivedFrom  'desktop-entry' | 'app-id' | 'app-name' | 'title-rule' | 'heur-rule' | 'fallback'
 * @property {object|null} matchedRule 命中的标题规则，未命中为 null
 * @property {boolean} isFallback
 * @property {boolean} mergeable   该组是否允许落入同一共享 Source
 * @property {'stack'|'replace'} mode  默认 stack；replace 仅显式配置；启发式组恒为 stack
 * @property {number} limit 每组上限，默认 NATIVE_SOURCE_LIMIT(10，原生值)
 * @property {string|null} displayName 规则 displayName，直通给组头显示
 * @property {number} ttlSec 组内存活秒数，0=关闭；仅 rules.groups 显式配置
 * @property {boolean} ignoreReplaces 是否剥离发送方 replaces_id（每事件强制新卡）；
 *   仅 rules.groups 显式 true；默认 false（尊重发送方原位更新语义）
 */

/**
 * 计算分组。
 * @param {NotifyInput} input
 * @param {Rules} [rules]
 * @returns {GroupResult}
 */
export function computeGroup(input, rules = {}) {
    const titlePrefixRules = rules.titlePrefixRules ?? [];
    const groups = rules.groups ?? {};

    const desktopEntry = normalizeName(input.desktopEntry);
    if (desktopEntry)
        return finish(`app:${desktopEntry}`, 'desktop-entry', null, true, groups, false);

    const appId = normalizeName(input.appId);
    if (appId)
        return finish(`app:${appId}`, 'app-id', null, true, groups, false);

    const appName = normalizeName(input.appName);
    const isAnonymous = !appName || ANONYMOUS_APP_NAMES.includes(appName);
    if (!isAnonymous)
        return finish(`app:${appName}`, 'app-name', null, true, groups, false);

    // 匿名来源：先查用户标题前缀规则表。
    const title = String(input.title ?? '');
    for (const rule of titlePrefixRules) {
        let re;
        try {
            re = new RegExp(rule.pattern);
        } catch {
            continue; // 非法正则直接跳过，不炸整条通知
        }
        if (re.test(title))
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
        const pattern = rule && rule.pattern;
        if (typeof pattern !== 'string') {
            rejected.push({ pattern: String(pattern), group: rule && rule.group, reason: 'not-a-string' });
            continue;
        }
        let re;
        try {
            re = new RegExp(pattern);
        } catch {
            rejected.push({ pattern, group: rule.group, reason: 'compile-error' });
            continue;
        }
        if (NESTED_QUANTIFIER_RE.test(pattern)) {
            rejected.push({ pattern, group: rule.group, reason: 'risky-nested-quantifier' });
            continue;
        }
        const t0 = Date.now();
        try {
            for (const probe of AUDIT_PROBES)
                re.test(probe);
        } catch {
            rejected.push({ pattern, group: rule.group, reason: 'probe-error' });
            continue;
        }
        const cost = Date.now() - t0;
        if (cost > RULE_AUDIT_BUDGET_MS) {
            rejected.push({ pattern, group: rule.group, reason: `slow-probe(${cost}ms)` });
            continue;
        }
        safe.push(rule);
    }
    return { safe, rejected };
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
    };
}
