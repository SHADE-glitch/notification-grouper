// prefs.js — the preferences page. It runs in a separate GTK4/Adw process (the prefs host is
// /usr/bin/gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions, D-Bus activated), so Adw/Gtk
// may be imported here; extension.js runs in the shell process and absolutely may not.
//
// Every widget and property name below was introspected on this machine's libadwaita 1.9.1, not
// written from memory:
//   has subtitle — ActionRow / SwitchRow / SpinRow / ExpanderRow
//   no subtitle — **EntryRow** (the whole prefs surface was once deleted because it set a subtitle
//   on it, see CHANGELOG D-001)
//   Adw.SpinRow has no value-changed signal, only properties; so the number goes through
//   settings.bind() on 'value' (the existing approach in this workspace's macos-dock, in daily use here)
//   Adw.EntryRow has no placeholder-text; use its title for the hint text
//   Adw.EntryRow's activate signal is named entry-activated (signal_lookup hits it, measured)
// The prefs object is built and destroyed with the dialog, so the changed:: handlers here carry no
// cross-session cleanup obligation; only a changed:: handler **in the shell process** must be
// disconnectable (see _settingsHids in extension.js).
//
// The four keys' defaults equal this extension's zero-config behaviour, so someone who never opens
// this page sees the same behaviour as before it was installed.
// UI text is English (consistent with the metadata description and the English README).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import { ExtensionPreferences } from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const NATIVE_MAX = 10;      // MAX_NOTIFICATIONS_PER_SOURCE in native messageTray.js:25
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
        // No bind: the key is an int and SpinRow.value is a double. This was measured — with bind,
        // GJS on 50.1 reports "GSettings key type does not match property type" (overrides/Gio.js:398)
        // and the binding silently does nothing without failing the dialog, which is the hardest kind
        // of error to find. Both directions are wired explicitly: writes go back to the setting, and
        // setting changes (including the Reset button) come back to the UI.
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
