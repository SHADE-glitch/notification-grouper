// groupEngine 单测（node --test）。fixtures 来自真实抓包。
// 引擎已瘦身为"零配置只按应用分"：只覆盖 identity 链 + 匿名隔离 + 挂接点自检。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    computeGroup, normalizeName, checkAttachPoints, REQUIRED_PATCHES, ANONYMOUS_APP_NAMES,
} from '../groupEngine.js';

const load = (n) =>
    JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

// 真实 fixture 1：CodeBuddy 真实 hook（匿名裸发送，app_name=notify-send）
// -> 匿名不可合并，走原生 per-pid 隔离（零配置下不做任何猜测）
test('codebuddy hook（匿名 notify-send）-> 不可合并，原生隔离', () => {
    const fx = load('codebuddy-hook.json');
    const r = computeGroup(fx._engine_input);
    assert.equal(r.mergeable, false);
    assert.equal(r.groupKey, null);
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

// 匿名来源：notify-send / node-notifier / 空 -> 一律不可合并
test('匿名来源一律不可合并', () => {
    for (const appName of ['notify-send', 'node-notifier', '', '   ']) {
        const r = computeGroup({ appName });
        assert.equal(r.mergeable, false, `appName=${JSON.stringify(appName)}`);
        assert.equal(r.groupKey, null);
    }
    assert.deepEqual(ANONYMOUS_APP_NAMES, ['notify-send', 'node-notifier', '']);
});

// 误合并防护：两个不同匿名发送者 -> 各自隔离，不合并
test('两个不同匿名发送者 -> 各自隔离', () => {
    const a = computeGroup({ appName: 'notify-send' });
    const b = computeGroup({ appName: '' });
    assert.equal(a.mergeable, false);
    assert.equal(b.mergeable, false);
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
