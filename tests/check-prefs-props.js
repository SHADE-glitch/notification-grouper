// tests/check-prefs-props.js — prefs.js 用到的控件属性/信号，逐个对着
// 本机 libadwaita 内省校验。不需要显示器：只查类，不实例化控件。
//
// 为什么存在：当年整套 prefs 被删掉，是因为给 Adw.EntryRow 设了 subtitle，而 1.9.1 的
// EntryRow 没有这个属性（见 CHANGELOG D-001）。那种错误不该再靠"打开设置页才发现"。
//
// 两侧都查，所以这张清单不能悄悄烂掉：
//   (a) 清单里的每个 (类, 成员) 必须真的存在于本机 Adw/Gtk —— 否则 prefs.js 会在
//       用户点开设置时才炸；
//   (b) 清单里的每个成员名必须仍出现在 prefs.js 源码里 —— 否则清单只是化石，
//       检查通过却什么也不保证。
// 用法：gjs tests/check-prefs-props.js      退出码 0 = 全通过
const Adw = imports.gi.Adw;
const Gtk = imports.gi.Gtk;
const GObject = imports.gi.GObject;

// kind: 'prop' 属性，'signal' 信号。name 是源码里出现的字面名。
const USED = [
    // 页面骨架
    { cls: 'Adw.PreferencesPage', kind: 'prop', name: 'title' },
    { cls: 'Adw.PreferencesPage', kind: 'prop', name: 'icon_name' },
    { cls: 'Adw.PreferencesGroup', kind: 'prop', name: 'title' },
    { cls: 'Adw.PreferencesGroup', kind: 'prop', name: 'description' },
    // 开关
    { cls: 'Adw.SwitchRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.SwitchRow', kind: 'prop', name: 'subtitle' },
    { cls: 'Adw.SwitchRow', kind: 'prop', name: 'active' },
    // 数值：SpinRow 只有属性没有 value-changed 信号，所以走 settings.bind('value')
    { cls: 'Adw.SpinRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.SpinRow', kind: 'prop', name: 'subtitle' },
    { cls: 'Adw.SpinRow', kind: 'prop', name: 'adjustment' },
    { cls: 'Adw.SpinRow', kind: 'prop', name: 'value' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'lower' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'upper' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'step_increment' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'page_increment' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'value' },
    // 例外表
    { cls: 'Adw.ExpanderRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.ExpanderRow', kind: 'prop', name: 'subtitle' },
    { cls: 'Adw.ExpanderRow', kind: 'prop', name: 'enable_expansion' },
    // EntryRow：有 title/text，**没有 subtitle**（D-001 的坑）、没有 placeholder-text
    { cls: 'Adw.EntryRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.EntryRow', kind: 'prop', name: 'text' },
    { cls: 'Adw.EntryRow', kind: 'signal', name: 'entry-activated' },
    // 动作行与按钮
    { cls: 'Adw.ActionRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.ActionRow', kind: 'prop', name: 'subtitle' },
    { cls: 'Adw.ActionRow', kind: 'prop', name: 'activatable_widget' },
    { cls: 'Gtk.Button', kind: 'prop', name: 'label' },
    { cls: 'Gtk.Button', kind: 'prop', name: 'icon_name' },
    { cls: 'Gtk.Button', kind: 'prop', name: 'valign' },
    { cls: 'Gtk.Button', kind: 'prop', name: 'css_classes' },
    { cls: 'Gtk.Button', kind: 'signal', name: 'clicked' },
];

// 反向钉住历史缺陷：这两条若哪天变成"存在"，说明 Adw 改了语义，清单要重读。
const MUST_NOT_EXIST = [
    { cls: 'Adw.EntryRow', kind: 'prop', name: 'subtitle' },
    { cls: 'Adw.EntryRow', kind: 'prop', name: 'placeholder-text' },
    { cls: 'Adw.SpinRow', kind: 'signal', name: 'value-changed' },
];

function resolve(fqn) {
    const [ns, cls] = fqn.split('.');
    const mod = ns === 'Adw' ? Adw : Gtk;
    return mod[cls] ?? null;
}

function hasProp(cls, name) {
    // GObject 属性名是带连字符的规范名（enable-expansion），而 GJS 的构造参数允许
    // 下划线别名（enable_expansion），同仓 macos-dock/prefs.js 就是这么写的。
    // 清单按规范名查，源码按别名出现——两边都认，才不会把"命名风格"误报成"属性不存在"。
    const dashed = name.replace(/_/g, '-');
    return cls.list_properties().some(p => p.name === name || p.name === dashed);
}

function hasSignal(cls, name) {
    const dashed = name.replace(/_/g, '-');
    return GObject.signal_lookup(name, cls.$gtype) !== 0 ||
        GObject.signal_lookup(dashed, cls.$gtype) !== 0;
}

function check(list, expect) {
    const problems = [];
    for (const u of list) {
        const cls = resolve(u.cls);
        if (!cls) {
            problems.push(`${u.cls} not available (Adw ${Adw.MAJOR_VERSION}.${Adw.MINOR_VERSION} / Gtk ${Gtk.MAJOR_VERSION}.${Gtk.MINOR_VERSION})`);
            continue;
        }
        const found = u.kind === 'prop' ? hasProp(cls, u.name) : hasSignal(cls, u.name);
        if (found !== expect)
            problems.push(`${u.cls}.${u.name} (${u.kind}) exists=${found} expected=${expect}`);
    }
    return problems;
}

const GLib = imports.gi.GLib;
// 相对脚本自身定位，不依赖调用者的 cwd
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(
    imports.system.programInvocationName));
const src = new TextDecoder().decode(
    GLib.file_get_contents(GLib.build_filenamev([ROOT, 'prefs.js']))[1]);

const bad = check(USED, true).concat(check(MUST_NOT_EXIST, false));

// (b) 清单必须仍然描述真实代码：每个成员名都得在 prefs.js 里出现
// （规范名或 GJS 的下划线别名，两种写法都算数）
for (const u of USED) {
    const dashed = u.name.replace(/_/g, '-');
    const under = u.name.replace(/-/g, '_');
    if (!src.includes(dashed) && !src.includes(under))
        bad.push(`prefs.js no longer mentions '${u.name}' — the checklist is stale, re-read the widgets`);
}

const adwV = `${Adw.MAJOR_VERSION}.${Adw.MINOR_VERSION}.${Adw.MICRO_VERSION}`;
const gtkV = `${Gtk.MAJOR_VERSION}.${Gtk.MINOR_VERSION}`;
print(`[check-prefs-props] libadwaita ${adwV}, gtk ${gtkV}; ` +
    `${USED.length} used + ${MUST_NOT_EXIST.length} forbidden members checked`);
for (const p of bad)
    print(`  FAIL  ${p}`);
if (bad.length > 0) {
    print(`\n${bad.length} problem(s)`);
    imports.system.exit(1);
}
print('  PASS  every widget member prefs.js uses exists on this machine');
