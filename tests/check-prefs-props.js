// tests/check-prefs-props.js — every widget property/signal prefs.js uses, introspected one by one
// against this machine's libadwaita. No display needed: it only inspects classes, never instantiates
// a widget.
//
// Why it exists: the whole prefs surface was once deleted because it set a subtitle on Adw.EntryRow,
// and 1.9.1's EntryRow has no such property (see CHANGELOG D-001). That kind of error should not have
// to wait for "someone opens the prefs page".
//
// Both sides are checked, so this list cannot rot quietly:
//   (a) every (class, member) in the list must really exist on this machine's Adw/Gtk — otherwise
//       prefs.js blows up only when the user opens the settings;
//   (b) every member name in the list must still appear in the prefs.js source — otherwise the list is
//       just a fossil and the check passes while guaranteeing nothing.
// Usage: gjs tests/check-prefs-props.js      exit code 0 = all pass
const Adw = imports.gi.Adw;
const Gtk = imports.gi.Gtk;
const GObject = imports.gi.GObject;

// kind: 'prop' for a property, 'signal' for a signal. name is the literal name as it appears in the source.
const USED = [
    // Page skeleton
    { cls: 'Adw.PreferencesPage', kind: 'prop', name: 'title' },
    { cls: 'Adw.PreferencesPage', kind: 'prop', name: 'icon_name' },
    { cls: 'Adw.PreferencesGroup', kind: 'prop', name: 'title' },
    { cls: 'Adw.PreferencesGroup', kind: 'prop', name: 'description' },
    // Switches
    { cls: 'Adw.SwitchRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.SwitchRow', kind: 'prop', name: 'subtitle' },
    { cls: 'Adw.SwitchRow', kind: 'prop', name: 'active' },
    // Number: SpinRow has only properties and no value-changed signal, so it goes through settings.bind('value')
    { cls: 'Adw.SpinRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.SpinRow', kind: 'prop', name: 'subtitle' },
    { cls: 'Adw.SpinRow', kind: 'prop', name: 'adjustment' },
    { cls: 'Adw.SpinRow', kind: 'prop', name: 'value' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'lower' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'upper' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'step_increment' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'page_increment' },
    { cls: 'Gtk.Adjustment', kind: 'prop', name: 'value' },
    // Exception list
    { cls: 'Adw.ExpanderRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.ExpanderRow', kind: 'prop', name: 'subtitle' },
    { cls: 'Adw.ExpanderRow', kind: 'prop', name: 'enable_expansion' },
    // EntryRow: has title/text, **no subtitle** (the D-001 trap) and no placeholder-text
    { cls: 'Adw.EntryRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.EntryRow', kind: 'prop', name: 'text' },
    { cls: 'Adw.EntryRow', kind: 'signal', name: 'entry-activated' },
    // Action rows and buttons
    { cls: 'Adw.ActionRow', kind: 'prop', name: 'title' },
    { cls: 'Adw.ActionRow', kind: 'prop', name: 'subtitle' },
    { cls: 'Adw.ActionRow', kind: 'prop', name: 'activatable_widget' },
    { cls: 'Gtk.Button', kind: 'prop', name: 'label' },
    { cls: 'Gtk.Button', kind: 'prop', name: 'icon_name' },
    { cls: 'Gtk.Button', kind: 'prop', name: 'valign' },
    { cls: 'Gtk.Button', kind: 'prop', name: 'css_classes' },
    { cls: 'Gtk.Button', kind: 'signal', name: 'clicked' },
];

// Pin the historical defect in reverse: if either of these ever becomes "present", Adw changed its semantics and the list must be re-read.
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
    // GObject property names are the canonical hyphenated form (enable-expansion), while GJS
    // construction arguments accept an underscore alias (enable_expansion), which is how this
    // workspace's macos-dock/prefs.js writes them. The list looks up the canonical name and the source
    // uses the alias — accepting both is what stops a "naming style" difference being misreported as
    // "the property does not exist".
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
// Located relative to the script itself, not depending on the caller's cwd
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(
    imports.system.programInvocationName));
const src = new TextDecoder().decode(
    GLib.file_get_contents(GLib.build_filenamev([ROOT, 'prefs.js']))[1]);

const bad = check(USED, true).concat(check(MUST_NOT_EXIST, false));

// (b) the list must still describe the real code: every member name must appear in prefs.js
// (either the canonical name or GJS's underscore alias counts)
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
