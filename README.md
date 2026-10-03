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

## 🛠️ Development

```
extension.js       the two wrappers, source cache, enable/disable
groupEngine.js     pure functions: normalisation, grouping, attach self-check
tests/             node --test suite, fixtures captured from real D-Bus traffic
scripts/bench.mjs  engine microbenchmark
```

`groupEngine.js` deliberately imports nothing from `gi://` or `Shell`, so the
same file runs under both GJS and Node and the grouping logic is testable
without a live session:

```sh
node --test              # 9 tests
node scripts/bench.mjs   # engine throughput
```

The JSON fixtures under `tests/fixtures/` were captured with `dbus-monitor` from
real notifications. Bodies are emptied and D-Bus bus names are replaced with
placeholders; sender pids are kept, because "every invocation has a different
pid" is the premise the whole extension rests on and the fixtures are the
evidence for it.

## ⚠️ Known limitations

- **Clicking one card dismisses the merged stack.** That is native
  `Source.open()` behaviour (`destroyNonResidentNotifications()`); merging
  across processes widens its scope from one process's cards to the group's.
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
