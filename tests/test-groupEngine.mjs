// groupEngine 单测（node --test）。fixtures 来自真实抓包。
// 引擎已瘦身为"零配置只按应用分"：只覆盖 identity 链 + 通用名/空名策略 + 挂接点自检。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    computeGroup, normalizeName, checkAttachPoints, REQUIRED_PATCHES,
    checkUiGuardPoints, REQUIRED_UI_GUARDS,
} from '../groupEngine.js';

const load = (n) =>
    JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

// 真实 fixture 1：CodeBuddy 真实 hook（裸 notify-send，app_name=notify-send）
// -> 通用名照样作为分组键，跨 pid 合并到一个共享源
test('codebuddy hook（notify-send）-> app:notify-send，可合并', () => {
    const fx = load('codebuddy-hook.json');
    const r = computeGroup(fx._engine_input);
    assert.equal(r.groupKey, 'app:notify-send');
    assert.equal(r.mergeable, true);
});

// 真实 fixture 2：Code-Notify 有 app_name 无 desktop-entry -> 稳定分组，零配置
test('codenotify test -> app:code-notify，可合并（新应用零配置即分组）', () => {
    const fx = load('codenotify-test.json');
    const r = computeGroup(fx._engine_input);
    assert.equal(r.groupKey, 'app:code-notify');
    assert.equal(r.mergeable, true);
});

// identity 链优先级：desktop-entry > appId > app_name
test('desktop-entry 优先于 app_name', () => {
    const r = computeGroup({ appName: 'electron-app', desktopEntry: 'Trae CN' });
    assert.equal(r.groupKey, 'app:trae cn');
    assert.equal(r.mergeable, true);
});

test('无 desktop-entry 时用 appId', () => {
    const r = computeGroup({ appName: 'electron', appId: 'org.example.App' });
    assert.equal(r.groupKey, 'app:org.example.app');
    assert.equal(r.mergeable, true);
});

// 归一化：大小写 / 首尾空白 / .desktop 后缀都不影响分组键
test('归一化：大小写与 .desktop 后缀不改变分组键', () => {
    assert.equal(computeGroup({ appName: 'SuperNewApp-XYZ' }).groupKey, 'app:supernewapp-xyz');
    assert.equal(computeGroup({ appName: 'supernewapp-xyz.desktop' }).groupKey, 'app:supernewapp-xyz');
    assert.equal(normalizeName('  Foo.Desktop  '), 'foo');
    assert.equal(normalizeName(undefined), '');
});

// 通用名（发送方声明的身份）照样分组；只有真正空 app_name 才隔离
test('通用名照样分组，空 app_name 才隔离', () => {
    for (const appName of ['notify-send', 'node-notifier']) {
        const r = computeGroup({ appName });
        assert.equal(r.mergeable, true, `appName=${JSON.stringify(appName)}`);
        assert.equal(r.groupKey, `app:${appName}`);
    }
    for (const appName of ['', '   ', undefined]) {
        const r = computeGroup({ appName });
        assert.equal(r.mergeable, false, `appName=${JSON.stringify(appName)}`);
        assert.equal(r.groupKey, null);
    }
});

// 误合并防护：两个不同的通用名 -> 各自成栈，不互相合并
test('两个不同通用名 -> 各自成栈', () => {
    const a = computeGroup({ appName: 'notify-send' });
    const b = computeGroup({ appName: 'node-notifier' });
    assert.equal(a.groupKey, 'app:notify-send');
    assert.equal(b.groupKey, 'app:node-notifier');
    assert.notEqual(a.groupKey, b.groupKey);
    assert.equal(computeGroup({ appName: '' }).mergeable, false);
});

test('空输入 -> 不可合并', () => {
    assert.deepEqual(computeGroup(), { groupKey: null, mergeable: false });
    assert.deepEqual(computeGroup({}), { groupKey: null, mergeable: false });
});

// 自降级决策：两挂接点齐全 -> 挂 2 处补丁；任一缺失 -> 不挂、只警告
test('checkAttachPoints：2 补丁齐全则 attach，缺失则 inert', () => {
    const full = {
        hasFdo: true, fdoKeys: '_fdoNotificationDaemon',
        hasNotifyAsync: true, hasGetSource: true,
    };
    const ok = checkAttachPoints(full);
    assert.equal(ok.attach, true);
    assert.deepEqual(ok.patches, REQUIRED_PATCHES);
    assert.deepEqual(REQUIRED_PATCHES, ['NotifyAsync', '_getSourceForPidAndName']);

    const noFdo = checkAttachPoints({ ...full, hasFdo: false, fdoKeys: 'Main.notificationDaemon is null' });
    assert.equal(noFdo.attach, false);
    assert.equal(noFdo.patches.length, 0);
    assert.match(noFdo.warnings.join(';'), /_fdoNotificationDaemon unreachable/);

    const noNotify = checkAttachPoints({ ...full, hasNotifyAsync: false });
    assert.equal(noNotify.attach, false);
    assert.match(noNotify.warnings.join(';'), /NotifyAsync missing/);

    const noGet = checkAttachPoints({ ...full, hasGetSource: false });
    assert.equal(noGet.attach, false);
    assert.match(noGet.warnings.join(';'), /_getSourceForPidAndName missing/);
});

// UI 兜底点自检：与分组补丁相互独立，且默认 fail-safe（信息不全就不挂）
test('checkUiGuardPoints：6 项齐全才 apply', () => {
    const full = {
        moduleLoaded: true, hasMessage: true, hasGroup: true,
        hasNotifMessage: true, hasUnexpand: true, hasCollapse: true,
        hasNotifClose: true,
    };
    const ok = checkUiGuardPoints(full);
    assert.equal(ok.apply, true);
    assert.deepEqual(ok.guards, REQUIRED_UI_GUARDS);
    assert.deepEqual(REQUIRED_UI_GUARDS,
        ['Message.unexpand', 'NotificationMessageGroup.collapse',
            'NotificationMessage.close']);
    // 独立性：兜底点绝不能和分组补丁点混为一谈
    assert.deepEqual(REQUIRED_UI_GUARDS.filter(g => REQUIRED_PATCHES.includes(g)), []);
});

test('checkUiGuardPoints：任一项缺失 -> 不挂、只警告', () => {
    const full = {
        moduleLoaded: true, hasMessage: true, hasGroup: true,
        hasNotifMessage: true, hasUnexpand: true, hasCollapse: true,
        hasNotifClose: true,
    };
    const cases = [
        ['moduleLoaded', /messageList module unavailable/],
        ['hasMessage', /Message class not exported/],
        ['hasGroup', /NotificationMessageGroup class not exported/],
        ['hasNotifMessage', /NotificationMessage class not exported/],
        ['hasUnexpand', /unexpand missing/],
        ['hasCollapse', /collapse missing/],
        ['hasNotifClose', /close missing/],
    ];
    for (const [key, re] of cases) {
        const r = checkUiGuardPoints({ ...full, [key]: false, detail: 'boom' });
        assert.equal(r.apply, false, `${key}=false must not apply`);
        assert.equal(r.guards.length, 0, `${key}=false must install nothing`);
        assert.match(r.warnings.join(';'), re, `${key}=false warning text`);
    }
    // 空输入必须走惰性分支，绝不能默认挂载
    assert.deepEqual(checkUiGuardPoints(), { apply: false, guards: [], warnings: checkUiGuardPoints().warnings });
    assert.equal(checkUiGuardPoints({}).apply, false);
});
