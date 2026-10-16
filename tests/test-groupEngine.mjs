// groupEngine unit tests (node --test). The fixtures come from real captures.
// The engine has been slimmed to "zero-config, group by app only": this covers the identity chain +
// the generic/empty-name policy + the attach-point self-checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    computeGroup, normalizeName, checkAttachPoints, REQUIRED_PATCHES,
    checkUiGuardPoints, REQUIRED_UI_GUARDS, normalizeIsolate,
} from '../groupEngine.js';

const load = (n) =>
    JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

// Real fixture 1: a hook script's bare notify-send call (app_name=notify-send)
// -> a generic name still serves as the grouping key and merges across pids into one shared source
test('hook via bare notify-send -> app:notify-send, mergeable', () => {
    const fx = load('notify-send-hook.json');
    const r = computeGroup(fx._engine_input);
    assert.equal(r.groupKey, 'app:notify-send');
    assert.equal(r.mergeable, true);
});

// Real fixture 2: a named CLI sending with an explicit --app-name and no desktop-entry -> stable grouping, zero-config
test('named CLI (no desktop-entry) -> app:example-notifier, mergeable (a new app groups with zero config)', () => {
    const fx = load('named-cli.json');
    const r = computeGroup(fx._engine_input);
    assert.equal(r.groupKey, 'app:example-notifier');
    assert.equal(r.mergeable, true);
});

// Identity chain priority: desktop-entry > appId > app_name
test('desktop-entry takes priority over app_name', () => {
    const r = computeGroup({ appName: 'electron-app', desktopEntry: 'Example IDE CN' });
    assert.equal(r.groupKey, 'app:example ide cn');
    assert.equal(r.mergeable, true);
});

test('falls back to appId when there is no desktop-entry', () => {
    const r = computeGroup({ appName: 'electron', appId: 'org.example.App' });
    assert.equal(r.groupKey, 'app:org.example.app');
    assert.equal(r.mergeable, true);
});

// Normalisation: case / surrounding spaces / the .desktop suffix do not affect the grouping key
test('normalisation: case and the .desktop suffix do not change the grouping key', () => {
    assert.equal(computeGroup({ appName: 'SuperNewApp-XYZ' }).groupKey, 'app:supernewapp-xyz');
    assert.equal(computeGroup({ appName: 'supernewapp-xyz.desktop' }).groupKey, 'app:supernewapp-xyz');
    assert.equal(normalizeName('  Foo.Desktop  '), 'foo');
    assert.equal(normalizeName(undefined), '');
});

// A generic name (the identity the sender declares) still groups; only a truly empty app_name is isolated
test('a generic name still groups; only an empty app_name is isolated', () => {
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

// Mis-merge protection: two different generic names -> each gets its own stack, no merging between them
test('two different generic names -> separate stacks', () => {
    const a = computeGroup({ appName: 'notify-send' });
    const b = computeGroup({ appName: 'node-notifier' });
    assert.equal(a.groupKey, 'app:notify-send');
    assert.equal(b.groupKey, 'app:node-notifier');
    assert.notEqual(a.groupKey, b.groupKey);
    assert.equal(computeGroup({ appName: '' }).mergeable, false);
});

test('empty input -> not mergeable', () => {
    assert.deepEqual(computeGroup(), { groupKey: null, mergeable: false });
    assert.deepEqual(computeGroup({}), { groupKey: null, mergeable: false });
});

// Self-degradation decision: both attach points present -> mount 2 patches; either missing -> mount nothing, warn only
test('checkAttachPoints: attaches with both patches present, inert when one is missing', () => {
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

// UI workaround-point self-check: independent of the grouping patches, and fail-safe by default (mount nothing when the info is incomplete)
test('checkUiGuardPoints: applies only when all 6 are present', () => {
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
    // Independence: workaround points must never be conflated with grouping patch points
    assert.deepEqual(REQUIRED_UI_GUARDS.filter(g => REQUIRED_PATCHES.includes(g)), []);
});

test('checkUiGuardPoints: any one missing -> mount nothing, warn only', () => {
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
    // Empty input must take the inert branch and never mount by default
    assert.deepEqual(checkUiGuardPoints(), { apply: false, guards: [], warnings: checkUiGuardPoints().warnings });
    assert.equal(checkUiGuardPoints({}).apply, false);
});

// ---- Settings surface: the grouping toggle and the exception list are pure inputs to the engine; the hot path does not read settings ----

test('grouping-enabled=false -> never merge (the key is still computed, but native per-pid is handed back)', () => {
    const off = computeGroup({ appName: 'Any', enabled: false });
    assert.deepEqual(off, { groupKey: null, mergeable: false });
    // The default must be "merge", or this change silently overturns the zero-config default
    assert.equal(computeGroup({ appName: 'Any' }).mergeable, true);
    assert.equal(computeGroup({ appName: 'Any', enabled: true }).mergeable, true);
});

test('isolate-apps hit -> that app is not merged; a miss merges as usual', () => {
    const iso = new Set(['foo']);
    assert.deepEqual(computeGroup({ appName: 'Foo', isolated: iso }),
        { groupKey: null, mergeable: false });
    assert.equal(computeGroup({ appName: 'Bar', isolated: iso }).mergeable, true);
    // An empty set is equivalent to passing nothing
    assert.equal(computeGroup({ appName: 'Foo', isolated: new Set() }).mergeable, true);
    assert.equal(computeGroup({ appName: 'Foo', isolated: null }).mergeable, true);
});

test('the exception list compares against the computed identity, not the raw app_name', () => {
    // desktop-entry takes priority over app_name: the exception list must name foo (the resolved identity); naming x has no effect
    const byEntry = computeGroup({ appName: 'x', desktopEntry: 'foo.desktop' });
    assert.equal(byEntry.groupKey, 'app:foo');
    assert.equal(computeGroup({ appName: 'x', desktopEntry: 'foo.desktop',
        isolated: new Set(['foo']) }).mergeable, false);
    assert.equal(computeGroup({ appName: 'x', desktopEntry: 'foo.desktop',
        isolated: new Set(['x']) }).mergeable, true);
});

test('normalizeIsolate: trims, lower-cases, strips .desktop, drops empty entries, de-duplicates', () => {
    const s = normalizeIsolate(['  Foo Bar  ', 'BAZ.desktop', '', '   ', 'foo bar', 'qux.desktop']);
    assert.deepEqual([...s].sort(), ['baz', 'foo bar', 'qux']);
    assert.deepEqual([...normalizeIsolate([])], []);
    assert.deepEqual([...normalizeIsolate()], []);
    assert.deepEqual([...normalizeIsolate(null)], []);
});
