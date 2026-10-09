// prefs.js — 设置页。跑在独立的 GTK4/Adw 进程里（prefs 宿主 =
// /usr/bin/gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions，D-Bus 激活），
// 所以这里可以 import Adw/Gtk；extension.js 在 shell 进程里，绝对不行。
//
// 控件与属性名全部在本机 libadwaita 1.9.1 上内省实测过，不是凭记忆写的：
//   有 subtitle —— ActionRow / SwitchRow / SpinRow / ExpanderRow
//   没 subtitle —— **EntryRow**（当年整套 prefs 被删就是给它设了 subtitle，见 CHANGELOG D-001）
//   Adw.SpinRow 没有 value-changed 信号，只有属性；所以数值用 settings.bind() 走
//   'value'（同仓 macos-dock 的既有做法，本机每天在用）
//   Adw.EntryRow 没有 placeholder-text；提示文字用它的 title
//   Adw.EntryRow 的回车信号名是 entry-activated（实测 signal_lookup 命中）
// prefs 对象随对话框一起构造与销毁，这里的 changed:: 不需要跨会话清理义务；
// **shell 进程里**的 changed:: 才必须可 disconnect（见 extension.js 的 _settingsHids）。
//
// 四个键的默认值就等于本扩展的零配置行为，所以从不打开这页的人，看到的行为与装上前一致。
// 界面文案用英文（与 metadata description、README 英文主文档一致）。

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import { ExtensionPreferences } from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const NATIVE_MAX = 10;      // 原生 messageTray.js:25 的 MAX_NOTIFICATIONS_PER_SOURCE
const ALL_KEYS = ['grouping-enabled', 'ui-guards', 'max-per-source', 'isolate-apps'];
const BIND = Gio.SettingsBindFlags.DEFAULT |
    Gio.SettingsBindFlags.GET |
    Gio.SettingsBindFlags.SET |
    Gio.SettingsBindFlags.NO_SENSITIVITY;

export default class NotificationGrouperPreferences extends ExtensionPreferences {
    #settings;
    #expander;
    #nameRows = [];

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this.#settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'Notification Grouper',
            icon_name: 'preferences-system-notifications-symbolic',
        });
        window.add(page);

        this.#addGrouping(page, settings);
        this.#addExceptions(page, settings);
        this.#addReset(page, settings);
    }

    #addGrouping(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Grouping',
            description: 'What the extension does to the notification list',
        });
        page.add(group);

        const grouping = new Adw.SwitchRow({
            title: 'Group notifications by app',
            subtitle: 'Turn off to get one stack per sending process, as GNOME does without this extension',
            active: settings.get_boolean('grouping-enabled'),
        });
        settings.bind('grouping-enabled', grouping, 'active', BIND);
        group.add(grouping);

        const guards = new Adw.SwitchRow({
            title: 'Work around two GNOME notification bugs',
            subtitle: 'Stops a collapsed stack from freezing the whole list, and closing one card from closing the stack',
            active: settings.get_boolean('ui-guards'),
        });
        settings.bind('ui-guards', guards, 'active', BIND);
        group.add(guards);

        const cap = new Adw.SpinRow({
            title: 'Cards kept per stack',
            subtitle: `GNOME already drops the oldest card past ${NATIVE_MAX}. Lower this to keep fewer; it cannot be raised.`,
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: NATIVE_MAX,
                step_increment: 1,
                page_increment: 1,
                value: settings.get_int('max-per-source'),
            }),
        });
        // 不 bind：键是 int、SpinRow.value 是 double。这是实测出来的——用 bind 时
        // GJS 在 50.1 上直接报 "GSettings key type does not match property type"
        // （overrides/Gio.js:398），绑定不生效却不让对话框失败，正是最难发现的那类错误。
        // 双向都显式接：写回设置，且设置变化（含 Reset 按钮）要回到界面上。
        let ignoreNotify = false;
        cap.connect('notify::value', () => {
            if (ignoreNotify)
                return;
            settings.set_int('max-per-source', Math.round(cap.value));
        });
        settings.connect('changed::max-per-source', () => {
            const v = settings.get_int('max-per-source');
            if (v === Math.round(cap.value))
                return;
            ignoreNotify = true;
            cap.value = v;
            ignoreNotify = false;
        });
        group.add(cap);
    }

    #addExceptions(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Apps that keep their own stacks',
            description: 'Names listed here are never merged. Compared ignoring case, surrounding spaces and a trailing .desktop.',
        });
        page.add(group);

        const expander = new Adw.ExpanderRow({
            title: 'Exceptions',
            enable_expansion: false,
        });
        group.add(expander);
        this.#expander = expander;

        const entry = new Adw.EntryRow({
            title: 'App name to keep separate',
        });
        const commit = () => {
            const value = entry.text.trim();
            if (value === '')
                return;
            const names = settings.get_strv('isolate-apps');
            if (!names.includes(value))
                settings.set_strv('isolate-apps', [...names, value]);
            entry.text = '';
        };
        entry.connect('entry-activated', commit);

        const addRow = new Adw.ActionRow({
            title: 'Add',
            subtitle: 'Writes the name above into the list',
        });
        const addBtn = new Gtk.Button({
            label: 'Add',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addBtn.connect('clicked', commit);
        addRow.add_suffix(addBtn);
        addRow.activatable_widget = addBtn;

        expander.add_row(entry);
        expander.add_row(addRow);

        this.#rebuildNames(settings);
        settings.connect('changed::isolate-apps', () => this.#rebuildNames(settings));
    }

    #rebuildNames(settings) {
        for (const row of this.#nameRows)
            this.#expander.remove(row);
        this.#nameRows = [];

        const names = settings.get_strv('isolate-apps');
        for (const name of names) {
            const row = new Adw.ActionRow({ title: name });
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => settings.set_strv('isolate-apps',
                settings.get_strv('isolate-apps').filter(n => n !== name)));
            row.add_suffix(remove);
            row.activatable_widget = remove;
            this.#expander.add_row(row);
            this.#nameRows.push(row);
        }

        this.#expander.title = names.length === 0
            ? 'Exceptions'
            : `Exceptions (${names.length})`;
        this.#expander.subtitle = names.length === 0
            ? 'None — every app gets its merged stack'
            : `Not merged: ${names.join(', ')}`;
        this.#expander.enable_expansion = names.length > 0;
    }

    #addReset(page, settings) {
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const row = new Adw.ActionRow({
            title: 'Restore every default',
            subtitle: 'Grouping on, bug workarounds on, GNOME cap of 10, no exceptions',
        });
        const btn = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        btn.connect('clicked', () => {
            for (const key of ALL_KEYS)
                settings.reset(key);
        });
        row.add_suffix(btn);
        row.activatable_widget = btn;
        group.add(row);
    }
}
