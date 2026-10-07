<p align="right"><a href="README.md"><b>English</b></a> | <a href="README.zh-CN.md">简体中文</a></p>

# Notification Grouper

A GNOME Shell extension that folds notifications from the same sending
application into a single stack, instead of one stack header per process.

![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-blue)
![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)
[![Repository](https://img.shields.io/badge/repository-GitHub-black?logo=github)](https://github.com/SHADE-glitch/notification-grouper)

GNOME 50. Zero configuration — no settings dialog, no rules file, no config keys.

## 📖 About

An **original extension** by **SHADE-glitch** — not a fork, with no upstream
project to attribute. It was written for GNOME Shell 50 and verified on GNOME
Shell 50.1 / Ubuntu 26.04. The whole extension is two method wrappers plus one
pure-function module: no settings surface, no UI of its own, no network.

## ❓ The problem

GNOME's Freedesktop.org notification backend caches its sources per
`pid + app_name`. For a long-lived app that is fine. But a command-line or
dev tool that sends one notification and exits gets a **fresh pid every time**,
and therefore a fresh source every time — and nothing ever retires those
sources, because the cleanup path only fires for senders that resolved to a
real `Shell.App`.

The result after a session of build hooks, CI pings and agent completion
notices is a wall of identically titled stack headers in the notification
centre, each holding one card.

This extension makes those share one source, keyed on the application that
sent them.

## 🚫 What it does not do

Read this before opening an issue — several of these are deliberate.

- **Notifications from an app that resolves to a `Shell.App` are left
  completely alone.** Native GNOME already stacks those per app; there is
  nothing to fix and this extension does not touch them.
- **Senders that declare no name at all are left alone.** The group key is the
  identity the sender declares, so a generic `app_name` such as `notify-send`
  or `node-notifier` is grouped under that name — one stack for `notify-send`,
  a separate one for `node-notifier`. Only a genuinely empty `app_name` counts
  as "this sender does not identify itself" and is left to native per-pid
  isolation. The flip side: two unrelated tools that both send as bare
  `notify-send` will share one stack. Give the sender a distinct `--app-name`
  (or a `desktop-entry` hint) if you want them kept apart.
- **No configuration of any kind.** Per-app branches, rule files and title
  patterns were all removed; the engine contains no application name at all.
  Grouping is a pure function of the identity the sender declares.
- **No UI changes.** Icons, titles, banners, urgency, click behaviour and the
  native 10-notifications-per-source cap are all left to GNOME. The extension
  injects no buttons and overrides no headers.

## 🔬 How it works

Two methods are wrapped on the FDO backend instance
(`Main.notificationDaemon._fdoNotificationDaemon`):

| Patch point | Role |
| --- | --- |
| `NotifyAsync` | Reads the hints at the entry point, computes the group, stashes the result |
| `_getSourceForPidAndName` | Consumes the stash; returns a shared source, or falls through to native |

The stash is a single slot, which is safe because the shell-side `NotifyAsync`
is a plain synchronous method — there is no `await` between reading the hints
and resolving the source, and D-Bus dispatch on that connection is not
reentrant. As a guard against that assumption being broken by a downstream
patch, the stash also carries the sender pid; if the pid seen by the two calls
ever disagrees, the notification falls through to native untouched and a single
warning is logged.

Both methods must exist for anything to be installed. If either is missing the
extension stays completely inert and logs one warning — it never half-attaches.

`disable()` restores both methods, disconnects the per-source handlers and
clears the cache.

### Group key

First match wins:

1. the `desktop-entry` hint
2. an application id (reserved for portal/Gtk paths; the FDO path rarely has one)
3. the normalised `app_name`, whenever it is non-empty — generic names included

Normalisation is: trim, lowercase, strip a trailing `.desktop`. So `Foo`,
` foo.desktop ` and `FOO` all land in the same group.

The hot path is a pure function with no regex, no file IO and no timers.

## 🧩 Compatibility

`shell-version` declares `50` only. That is the version the two patch points and
the resulting behaviour were verified against (GNOME Shell 50.1, Ubuntu 26.04).
Versions 48 and 49 look source-compatible but were not run, so they are not
claimed.

Note that GNOME's own compatibility check compares **major versions only**, so
this extension will keep loading unchanged on 50.2, 50.3 and so on. Because it
depends on a private method name, that name may be renamed in a point release.
The failure mode is designed for that: the extension goes inert and logs one
line, rather than throwing.

To check which case you are in:

```sh
journalctl --user -b | grep notification-grouper
```

Healthy:

```
[notification-grouper] enabled, attached patches: NotifyAsync, _getSourceForPidAndName
```

Upstream renamed something — please open an issue with this line:

```
[notification-grouper] WARNING degraded, staying inert: ...
```

## 🔒 Privacy

- Notification **bodies are never written to the log**, and there is no
  per-notification logging at all: one line per enable and one per disable.
- No network access. No files written. No state persisted. The only thing read
  is the sender-declared identity already present in each notification.

## 📥 Install

Requires GNOME Shell 50 on Ubuntu (verified on Ubuntu 26.04 with GNOME Shell
50.1). No build step and no dependencies beyond `git`.

```sh
# 1. clone straight into the extensions directory
git clone https://github.com/SHADE-glitch/notification-grouper.git \
  ~/.local/share/gnome-shell/extensions/notification-grouper@local

# 2. enable it
gnome-extensions enable notification-grouper@local
```

You can also enable it from the **Extensions** app.

**Log out and back in** — that is the reliable way to load a freshly cloned
extension. Toggling it off and on does **not** reload edited JavaScript: the
shell caches ES modules per process, so verifying a code change needs a shell
restart.

### Uninstall

```sh
gnome-extensions disable notification-grouper@local
rm -rf ~/.local/share/gnome-shell/extensions/notification-grouper@local
```

## 🔨 Development

```
extension.js       the two daemon wrappers, source cache, UI guards, enable/disable
groupEngine.js     pure functions: normalisation, grouping, attach self-checks
tests/             node suite + headless runtime harnesses
scripts/bench.mjs  engine microbenchmark
```

`groupEngine.js` deliberately imports nothing from `gi://` or `Shell`, so the
same file runs under both GJS and Node and the grouping logic is testable
without a live session:

```sh
npm test                   # 11 pure-function cases
npm run bench              # engine throughput
npm run verify:headless    # 12 runtime assertions against a throwaway shell
tests/headless-ui-guard.sh <dir> <label>   # provokes the native collapse fault
```

`npm test` covers **only** `groupEngine.js` — it cannot execute `extension.js` at all.
The two headless harnesses boot a private GNOME Shell (`dbus-run-session`,
`GSETTINGS_BACKEND=memory`, a private `XDG_DATA_HOME`) so they never touch your session,
your settings, or your notification tray. `tests/headless-ui-guard.sh` runs an assertion
against two builds so it must *flip* between them; a probe that merely passes on the new
code proves nothing.

The harnesses also encode traps that cost real time to discover: GNOME 50 rejects
symlinked extension directories (copy instead), `--nested` was removed, `gdbus` parses a
bare `-1` argument as an option, and `GLib.spawn_async` returns a pid rather than a
subprocess handle.

The JSON fixtures under `tests/fixtures/` were captured with `dbus-monitor` from
real notifications. Bodies are emptied and D-Bus bus names are replaced with
placeholders; sender pids are kept, because "every invocation has a different
pid" is the premise the whole extension rests on and the fixtures are the
evidence for it.

## 🩹 Workaround for a GNOME 50 notification-list defect

GNOME 50's own `ui/messageList.js` has a race that can leave the notification list
**frozen — clicking anything does nothing**. This extension ships two narrow guards
against it.

Why an extension for *grouping* patches shell UI: grouping makes stacks bigger, and a
bigger group is what makes the pre-existing defect reachable. Native caches one source per
`pid + app_name`, so most groups held exactly one card and never hit the path. Merging
converts many one-card groups into a few N-card groups, so the exposure moves from
near-zero to occasional. That is a consequence of this feature, so mitigating it is this
extension's business.

The defect, verified against GNOME Shell 50.1 line numbers:

1. `_removeNotification` reads `item.layout_manager` at `messageList.js:1161`, but only
   deletes its map entry inside the animation callback at `:1170`. A throw at `:1161`
   therefore leaves a **stale message** in `_notificationToMessage`.
2. `collapse()` then iterates that stale entry at `:992`, and `Message.unexpand` (`:646`)
   calls `ease_property('@layout.expansion', …)`.
3. `_easeAnimatableProperty` is a **plain function, not `async`** (`environment.js:196`),
   so the `TypeError` is thrown synchronously and the `.catch()` at `:341` never sees it.
4. `collapse()` has no `try/finally`, so `_expanded = false` (`:998`) and `_cover.show()`
   (`:1000`) never run. The group is stuck half-collapsed forever, and from then on every
   click is swallowed by the `if (!this.expanded)` branch at `:1114`.

The guards: `Message.unexpand` lands its end state instead of throwing when the actor has
no layout manager (which lets the loop finish for the remaining messages), and
`NotificationMessageGroup.collapse` forces the state to land if anything still throws.

Both guards are **strictly independent of grouping** — reached by dynamic `import()`, so a
GNOME version that renames `messageList.js` costs you only the guards, never grouping. They
work around a bug that belongs upstream; **delete them once GNOME fixes it**, and please
open an issue if you see `UI guards degraded` in the journal.

### Click behaviour to expect (native, not configurable)

- **Clicking a card in a collapsed group does not activate it — it only expands the
  group.** `messageList.js:1114` stops the click emission and turns it into an
  expand request. A group of exactly **one** card is treated as already expanded (`:952`),
  which is why small native groups appeared to "click and dismiss". Merged groups are
  multi-card, so expect the first click to expand and the click on the revealed card to act.
- **A notification from a sender that does not resolve to an application can never jump
  anywhere.** `openApp()` returns immediately when `source.app` is null, and the path this
  extension handles is precisely the path where it is null. Whether a click launches
  something is decided by the *sender* offering a `default` action
  (`notificationDaemon.js:232-241`) — no extension can retrofit it.
- Clicking a card in a collapsed group's close button closes the **entire group** (`:1107`).

## ⚠️ Known limitations

- **Clicking one card dismisses the whole merged stack** once the group is expanded (or
  when it holds a single card). That is native `Source.open()` behaviour
  (`destroyNonResidentNotifications()`); merging across processes widens its scope from
  one process's cards to the group's. See "Click behaviour to expect" above for why the
  first click on a collapsed multi-card group only expands it.
- **A `desktop-entry` hint that names a non-existent `.desktop` file decouples
  the group key from the stack title.** The group is keyed on the hint while
  the title comes from `app_name`. Narrow case — real GTK apps resolve to an
  `App` and take the native path — but two applications sharing such a hint
  would land in one stack.
- **Disabling does not un-group.** Stacks merged while enabled keep their
  contents; only newly arriving notifications go back to per-pid sources.
- The extension UUID is `notification-grouper@local`.

## 🤝 Contributing

Issues and pull requests are welcome. Please keep changes scoped, and run the
test suite described under [Development](#-development) before opening a PR.

## ⚖️ License

GPL-2.0-or-later · `SPDX-License-Identifier: GPL-2.0-or-later`. See [LICENSE](LICENSE) — it is the verbatim FSF text, which is why GitHub's automatic detector reports plain GPL-2.0; the declaration above is what is actually granted.

---

完整中文说明见 [README.zh-CN.md](README.zh-CN.md)。
