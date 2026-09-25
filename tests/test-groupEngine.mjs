// groupEngine 单测（node --test）。fixtures 来自真实抓包；
// 标 [synthetic-logic] 的用例仅覆盖纯函数分支，不作为"分组有效"证据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeGroup, heuristicPrefix, humanizeGroupKey, checkAttachPoints, REQUIRED_PATCHES, auditTitleRules, compileRules, normalizeUrgency } from '../groupEngine.js';

const EMPTY_RULES = { titlePrefixRules: [], groups: {} };
const load = (n) =>
    JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

// 真实 fixture 1：CodeBuddy 真实 hook（匿名裸发送），空规则 -> 兜底且不可合并
// （"CodeBuddy 任务完成" 无冒号分隔符，保守启发式不命中）
test('codebuddy hook + 空规则 -> fallback:notify-send，不可合并，默认 stack', () => {
    const fx = load('codebuddy-hook.json');
    const r = computeGroup(fx._engine_input, EMPTY_RULES);
    assert.equal(r.groupKey, 'fallback:notify-send');
    assert.equal(r.derivedFrom, 'fallback');
    assert.equal(r.isFallback, true);
    assert.equal(r.mergeable, false);
    assert.equal(r.mode, 'stack');
    assert.equal(r.limit, 10);
});

// 真实 fixture 1 + 示例规则 -> 命中标题规则，可合并（Q1 合并的前提）
test('codebuddy hook + 示例标题规则 -> app:codebuddy，可合并', () => {
    const fx = load('codebuddy-hook.json');
    const rules = {
        titlePrefixRules: [{ pattern: '^CodeBuddy', group: 'codebuddy' }],
        groups: {},
    };
    const r = computeGroup(fx._engine_input, rules);
    assert.equal(r.groupKey, 'app:codebuddy');
    assert.equal(r.derivedFrom, 'title-rule');
    assert.equal(r.mergeable, true);
    assert.equal(r.mode, 'stack'); // 未显式声明 replace，不得单卡替换
});

// 真实 fixture 2：Code-Notify 有 app_name 无 desktop-entry -> 稳定分组，无需规则
test('codenotify test + 空规则 -> app:code-notify（新应用零规则即可分组）', () => {
    const fx = load('codenotify-test.json');
    const r = computeGroup(fx._engine_input, EMPTY_RULES);
    assert.equal(r.groupKey, 'app:code-notify');
    assert.equal(r.derivedFrom, 'app-name');
    assert.equal(r.mergeable, true);
    assert.equal(r.mode, 'stack');
});

// [synthetic-logic] desktop-entry 优先于 app_name（暂无真实 desktop-entry 抓包，
// 该分支结论只在 L3 拿到 Trae/Qoder 真实载荷后才算验证）
test('[synthetic-logic] desktop-entry 优先于 app_name', () => {
    const r = computeGroup(
        { appName: 'electron-app', desktopEntry: 'Trae CN', title: 'x' },
        EMPTY_RULES
    );
    assert.equal(r.groupKey, 'app:trae cn');
    assert.equal(r.derivedFrom, 'desktop-entry');
});

// replace 必须显式声明；非法正则不炸通知
test('replace 仅显式生效；非法正则跳过进兜底', () => {
    const fx = load('codebuddy-hook.json');
    const rules = {
        titlePrefixRules: [{ pattern: '([', group: 'broken' }],
        groups: { 'fallback:notify-send': { mode: 'replace' } },
    };
    const r = computeGroup(fx._engine_input, rules);
    assert.equal(r.derivedFrom, 'fallback');
    // 即使 groups 里写了 fallback 的 replace，兜底 mergeable=false，
    // 扩展层也不得对其做跨 Source 合并（engine 如实返回 mode，合并由 mergeable 门控）
    assert.equal(r.mergeable, false);

    const r2 = computeGroup({ appName: 'opencode', title: 'done' }, { titlePrefixRules: [], groups: { 'app:opencode': { mode: 'replace', limit: 1 } } });
    assert.equal(r2.mode, 'replace');
    assert.equal(r2.limit, 1);
});

// 通用性：从没见过的新应用，零规则零代码改动得到稳定分组
test('未见过的新应用零规则 -> 稳定 app: 分组', () => {
    const a = computeGroup({ appName: 'SuperNewApp-XYZ', title: 'hello' }, EMPTY_RULES);
    const b = computeGroup({ appName: 'supernewapp-xyz.desktop', title: 'other' }, EMPTY_RULES);
    assert.equal(a.groupKey, 'app:supernewapp-xyz');
    assert.equal(b.groupKey, 'app:supernewapp-xyz');
});

// node-notifier 视为匿名（无辨识度 key）
test('node-notifier 视为匿名 -> 兜底不可合并', () => {
    const r = computeGroup({ appName: 'node-notifier', title: 'hello world' }, EMPTY_RULES);
    assert.equal(r.derivedFrom, 'fallback');
    assert.equal(r.mergeable, false);
});

// 误合并单测：两个不同匿名发送者标题都是 "Error: ..." 时不得合到一起。
// 期望行为："error" 在停表里，双方各自 fallback:notify-send 且 mergeable=false，
// 扩展层不合并，原生按 pid 隔离。注意 groupKey 相同但 mergeable=false 即"不合并"。
test('误合并：双匿名 Error: 标题 -> 各自兜底，均不可合并', () => {
    const a = computeGroup({ appName: 'notify-send', title: 'Error: disk full', sender: ':1.101' }, EMPTY_RULES);
    const b = computeGroup({ appName: 'notify-send', title: 'Error: net down', sender: ':1.102' }, EMPTY_RULES);
    assert.equal(a.derivedFrom, 'fallback');
    assert.equal(b.derivedFrom, 'fallback');
    assert.equal(a.mergeable, false);
    assert.equal(b.mergeable, false);
});

// 启发式：冒号前缀成组、可合并、恒为 stack（即使 groups 写 replace 也强制 stack）
test('启发式 Backup: -> heur:backup，可合并但恒为 stack', () => {
    const rules = { titlePrefixRules: [], groups: { 'heur:backup': { mode: 'replace' } } };
    const r = computeGroup({ appName: 'notify-send', title: 'Backup: done at 03:00' }, rules);
    assert.equal(r.groupKey, 'heur:backup');
    assert.equal(r.derivedFrom, 'heur-rule');
    assert.equal(r.mergeable, true);
    assert.equal(r.mode, 'stack');
});

// 启发式全局开关关闭 -> 回兜底
test('启发式关闭 -> 兜底', () => {
    const rules = { titlePrefixRules: [], groups: {}, heuristicTitlePrefix: false };
    const r = computeGroup({ appName: 'notify-send', title: 'Backup: done' }, rules);
    assert.equal(r.derivedFrom, 'fallback');
    assert.equal(r.mergeable, false);
});

// 启发式细节：括号形式、停表词、纯数字
test('heuristicPrefix 细节', () => {
    assert.equal(heuristicPrefix('[MyTool] something happened'), 'mytool');
    assert.equal(heuristicPrefix('Warning: low disk'), null); // 停表
    assert.equal(heuristicPrefix('12345: code'), null); // 纯数字
    assert.equal(heuristicPrefix('CodeBuddy 任务完成'), null); // 无分隔符，需走规则
    assert.equal(heuristicPrefix(''), null);
});

// [Build] 反例 decisions：两个无关匿名来源都用 "[Build]" 前缀 -> 会合并。
// 决定：合并（heur:build，恒 stack，不丢消息）。理由：与 "Error:" 不同，
// "[Build]" 是话题而非严重度词；启发式组只做话题堆叠、组头显示话题名；
// 需要严格隔离的用户可写显式规则或关掉 heuristicTitlePrefix。
// L2-live 双真实源证据缺失（本机无第二个可自由标题的真实匿名脚本），
// 此处以单测锁定行为，L2 报告标未验证。
test('[Build] 反例：双无关匿名源同前缀 -> 合并为 heur:build（恒 stack）', () => {
    const a = computeGroup({ appName: 'notify-send', title: '[Build] app-a ok', sender: ':1.201' }, EMPTY_RULES);
    const b = computeGroup({ appName: '', title: '[Build] app-b failed', sender: ':1.202' }, EMPTY_RULES);
    assert.equal(a.groupKey, 'heur:build');
    assert.equal(b.groupKey, 'heur:build');
    assert.equal(a.mergeable, true);
    assert.equal(b.mergeable, true);
    assert.equal(a.mode, 'stack');
    assert.equal(b.mode, 'stack');
});

// 自降级决策：挂接点齐全 -> 挂 3 处补丁；任一缺失 -> 不挂、只警告
test('checkAttachPoints：齐全则 attach，缺失则 inert', () => {
    const full = {
        hasFdo: true, fdoKeys: '_fdoNotificationDaemon',
        hasNotifyAsync: true, hasGetSource: true,
        hasFdoSourceClass: true, hasProcessNotification: true,
    };
    const ok = checkAttachPoints(full);
    assert.equal(ok.attach, true);
    assert.deepEqual(ok.patches, REQUIRED_PATCHES);
    assert.deepEqual(REQUIRED_PATCHES, ['NotifyAsync', '_getSourceForPidAndName', 'processNotification']);

    const noFdo = checkAttachPoints({ ...full, hasFdo: false, fdoKeys: 'Main.notificationDaemon is null' });
    assert.equal(noFdo.attach, false);
    assert.equal(noFdo.patches.length, 0);
    assert.match(noFdo.warnings.join(';'), /_fdoNotificationDaemon unreachable/);

    const noMethod = checkAttachPoints({ ...full, hasGetSource: false });
    assert.equal(noMethod.attach, false);
    assert.match(noMethod.warnings.join(';'), /_getSourceForPidAndName missing/);

    const noClass = checkAttachPoints({ ...full, hasFdoSourceClass: false });
    assert.equal(noClass.attach, false);
    assert.match(noClass.warnings.join(';'), /not exported/);

    const noProcess = checkAttachPoints({ ...full, hasProcessNotification: false });
    assert.equal(noProcess.attach, false);
    assert.match(noProcess.warnings.join(';'), /processNotification missing/);
});

// displayName 直通 + humanize 回退
test('displayName 直通给组头；无则 humanize', () => {
    const rules = { titlePrefixRules: [{ pattern: '^CodeBuddy', group: 'codebuddy' }], groups: { 'app:codebuddy': { displayName: 'CodeBuddy' } } };
    const r = computeGroup({ appName: 'notify-send', title: 'CodeBuddy 任务完成' }, rules);
    assert.equal(r.displayName, 'CodeBuddy');
    assert.equal(humanizeGroupKey('app:trae cn'), 'trae cn');
    assert.equal(humanizeGroupKey('heur:backup'), 'backup');
});

// ReDoS 审计：灾难回溯 / 非法 / 正常 pattern 的去留
test('auditTitleRules 拒载危险 pattern', () => {
    const { safe, rejected } = auditTitleRules([
        { pattern: '^CodeBuddy', group: 'codebuddy' },
        { pattern: '^(a+)+$', group: 'evil' },
        { pattern: '([', group: 'broken' },
        { pattern: 42, group: 'nonstr' },
    ]);
    assert.equal(safe.length, 1);
    assert.equal(safe[0].group, 'codebuddy');
    const reasons = Object.fromEntries(rejected.map(r => [r.group, r.reason]));
    assert.equal(reasons.evil, 'risky-nested-quantifier');
    assert.equal(reasons.broken, 'compile-error');
    assert.equal(reasons.nonstr, 'not-a-string');
    // 被拒的 evil 不得再生效：即使标题命中也不合并
    const rules = { titlePrefixRules: safe, groups: {} };
    const r = computeGroup({ appName: 'notify-send', title: 'aaaa Evil' }, rules);
    assert.equal(r.derivedFrom, 'fallback');
});

// ignoreReplaces：默认关闭；显式 true 才直通（扩展层据此剥离 replaces_id）
test('ignoreReplaces 默认关、显式开', () => {
    const off = computeGroup({ appName: 'opencode', title: 'done' }, EMPTY_RULES);
    assert.equal(off.ignoreReplaces, false);
    const on = computeGroup({ appName: 'opencode', title: 'done' },
        { titlePrefixRules: [], groups: { 'app:opencode': { ignoreReplaces: true } } });
    assert.equal(on.ignoreReplaces, true);
    assert.equal(on.mode, 'stack'); // 不改变模式，只影响 replaces 处理
    const truthy = computeGroup({ appName: 'opencode', title: 'done' },
        { titlePrefixRules: [], groups: { 'app:opencode': { ignoreReplaces: 1 } } });
    assert.equal(truthy.ignoreReplaces, false); // 必须严格 true
});

// Step 4：ttlSec 直通（显式正整数才生效）与 limit 校验
test('ttlSec/limit 解析', () => {
    const rules = {
        titlePrefixRules: [],
        groups: {
            'app:code-notify': { mode: 'stack', limit: 3, ttlSec: 60 },
            'app:bad': { limit: -2, ttlSec: 'x' },
        },
    };
    const ok = computeGroup({ appName: 'Code-Notify', title: 't' }, rules);
    assert.equal(ok.limit, 3);
    assert.equal(ok.ttlSec, 60);
    const bad = computeGroup({ appName: 'bad', title: 't' }, rules);
    assert.equal(bad.limit, 10);
    assert.equal(bad.ttlSec, 0);
    const def = computeGroup({ appName: 'plain', title: 't' }, EMPTY_RULES);
    assert.equal(def.limit, 10);
    assert.equal(def.ttlSec, 0);
});

// ---- Phase 1/2 新增：compileRules / sourceRules / blockRules / bodyPattern / urgency ----

// compileRules：预编译 + 危险 pattern 拒载（含 bodyPattern），schema 错误逐条记录
test('compileRules 预编译并拒绝危险 pattern', () => {
    const { rules, errors, rejected } = compileRules({
        titlePrefixRules: [
            { pattern: '^CodeBuddy', group: 'codebuddy' },
            { pattern: '^(a+)+$', group: 'evil' },
            { pattern: '^OK', group: 'ok', bodyPattern: '(a+)+$' },
            { pattern: '^NoGroup' },
            { pattern: '^U', group: 'u', urgency: 'bogus' },
        ],
    });
    assert.equal(rules.titlePrefixRules.length, 2); // ^CodeBuddy 与 ^U（urgency 非法仅记错保留条目）
    assert.ok(rules.titlePrefixRules[0].re instanceof RegExp);
    const reasons = rejected.map(r => `${r.pattern}:${r.reason}`);
    assert.ok(reasons.some(s => s.includes('^(a+)+$:risky-nested-quantifier')));
    assert.ok(rejected.some(r => r.where.endsWith('.bodyPattern')));
    assert.ok(errors.some(e => e.reason === 'group-missing'));
    assert.ok(errors.some(e => e.reason === 'bad-urgency(ignored)'));
    // 被拒规则不进热路径
    const r = computeGroup({ appName: 'notify-send', title: 'aaaa Evil' }, rules);
    assert.equal(r.derivedFrom, 'fallback');
});

// 预编译与未编译行为一致（热路径复用 rule.re，行为不得变）
test('预编译规则与未编译行为一致', () => {
    const raw = { titlePrefixRules: [{ pattern: '^CodeBuddy', group: 'codebuddy' }], groups: {} };
    const compiled = compileRules(raw).rules;
    const inp = { appName: 'notify-send', title: 'CodeBuddy 任务完成' };
    const a = computeGroup(inp, raw);
    const b = computeGroup(inp, compiled);
    assert.equal(a.groupKey, b.groupKey);
    assert.equal(a.derivedFrom, b.derivedFrom);
    assert.equal(b.matchedRule.re instanceof RegExp, true);
});

// sourceRules 白名单：匿名来源也可显式强制合并；group 归一化
test('sourceRules 强制合并匿名来源', () => {
    const rules = compileRules({
        sourceRules: [{ appName: 'notify-send', group: 'MyTool' }],
    }).rules;
    const r = computeGroup({ appName: 'notify-send', title: 'whatever' }, rules);
    assert.equal(r.groupKey, 'app:mytool');
    assert.equal(r.derivedFrom, 'source-rule');
    assert.equal(r.mergeable, true);
    // 多字段 AND：appName 匹配但 desktopEntry 不匹配 -> 不命中
    const rules2 = compileRules({
        sourceRules: [{ appName: 'notify-send', desktopEntry: 'trae', group: 'x' }],
    }).rules;
    const r2 = computeGroup({ appName: 'notify-send', title: 't' }, rules2);
    assert.notEqual(r2.derivedFrom, 'source-rule');
});

// blockRules 黑名单：veto 优先于 sourceRules 与 identity 链（非匿名 app 也可拉黑）
test('blockRules veto 最高优先', () => {
    const rules = compileRules({
        sourceRules: [{ appName: 'Code-Notify', group: 'cn' }],
        blockRules: [{ appName: 'code-notify' }],
    }).rules;
    const r = computeGroup({ appName: 'Code-Notify', title: 't' }, rules);
    assert.equal(r.derivedFrom, 'blocked');
    assert.equal(r.mergeable, false);
    // desktop-entry 发送者也可拉黑
    const rules2 = compileRules({ blockRules: [{ desktopEntry: 'trae' }] }).rules;
    const r2 = computeGroup({ appName: 'x', desktopEntry: 'Trae', title: 't' }, rules2);
    assert.equal(r2.derivedFrom, 'blocked');
    assert.equal(r2.mergeable, false);
});

// blockRules titlePattern：匿名标题命中即 veto
test('blockRules titlePattern 命中匿名来源', () => {
    const rules = compileRules({ blockRules: [{ titlePattern: '^Deploy:' }] }).rules;
    const r = computeGroup({ appName: 'notify-send', title: 'Deploy: prod done' }, rules);
    assert.equal(r.derivedFrom, 'blocked');
    assert.equal(r.mergeable, false);
    const r2 = computeGroup({ appName: 'notify-send', title: 'Backup: ok' }, rules);
    assert.equal(r2.derivedFrom, 'heur-rule'); // 未命中不影响启发式
});

// titlePrefixRules 叠加 bodyPattern：标题命中但 body 不匹配 -> 不合并
test('bodyPattern 过滤', () => {
    const rules = compileRules({
        titlePrefixRules: [{ pattern: '^CodeBuddy', group: 'codebuddy', bodyPattern: '失败' }],
    }).rules;
    const noBody = computeGroup({ appName: 'notify-send', title: 'CodeBuddy 任务完成', body: '' }, rules);
    assert.equal(noBody.derivedFrom, 'fallback'); // body 不中且启发式不认裸空格前缀
    const hit = computeGroup({ appName: 'notify-send', title: 'CodeBuddy 构建失败', body: '步骤3 失败' }, rules);
    assert.equal(hit.groupKey, 'app:codebuddy');
    assert.equal(hit.mergeable, true);
});

// titlePrefixRules 叠加 urgency：级别不符 -> 不命中；字符串级别名归一化
test('urgency 过滤', () => {
    const rules = compileRules({
        titlePrefixRules: [{ pattern: '^Alert', group: 'alert', urgency: 'critical' }],
    }).rules;
    const low = computeGroup({ appName: 'notify-send', title: 'Alert: disk', urgency: 1 }, rules);
    assert.notEqual(low.derivedFrom, 'title-rule');
    const crit = computeGroup({ appName: 'notify-send', title: 'Alert: disk', urgency: 2 }, rules);
    assert.equal(crit.derivedFrom, 'title-rule');
    assert.equal(crit.groupKey, 'app:alert');
    assert.equal(normalizeUrgency('low'), 0);
    assert.equal(normalizeUrgency('CRITICAL'), 2);
    assert.equal(normalizeUrgency('x'), null);
    assert.equal(normalizeUrgency(undefined), null);
});

// groups 新字段直通：iconName/showCount/collapseWindowSec；非法值回退默认
test('groups 新字段直通与校验', () => {
    const { rules, errors } = compileRules({
        groups: {
            'app:ci': { iconName: 'emblem-synchronizing', showCount: true, collapseWindowSec: 5 },
            'app:bad': { collapseWindowSec: -3, showCount: 1, mode: 'bogus' },
        },
    });
    const ok = computeGroup({ appName: 'ci', title: 't' }, rules);
    assert.equal(ok.iconName, 'emblem-synchronizing');
    assert.equal(ok.showCount, true);
    assert.equal(ok.collapseWindowSec, 5);
    const bad = computeGroup({ appName: 'bad', title: 't' }, rules);
    assert.equal(bad.collapseWindowSec, 0);
    assert.equal(bad.showCount, false);
    assert.equal(bad.mode, 'stack');
    assert.ok(errors.some(e => e.where === 'groups.app:bad.collapseWindowSec'));
    assert.ok(errors.some(e => e.where === 'groups.app:bad.mode'));
    // 未配置默认
    const def = computeGroup({ appName: 'plain', title: 't' }, EMPTY_RULES);
    assert.equal(def.iconName, null);
    assert.equal(def.showCount, false);
    assert.equal(def.collapseWindowSec, 0);
});

// compileRules 根级与表级 schema 错误
test('compileRules schema 错误逐条记录', () => {
    const bad1 = compileRules(null);
    assert.ok(bad1.errors.some(e => e.where === 'root'));
    const bad2 = compileRules({ titlePrefixRules: 'x', groups: [], sourceRules: {} });
    assert.ok(bad2.errors.some(e => e.where === 'titlePrefixRules'));
    assert.ok(bad2.errors.some(e => e.where === 'groups'));
    assert.ok(bad2.errors.some(e => e.where === 'sourceRules'));
    // 错误不影响默认开关
    assert.equal(bad2.rules.heuristicTitlePrefix, true);
    assert.equal(bad2.rules.debug, false);
});
