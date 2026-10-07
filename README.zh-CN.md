<p align="right"><a href="README.md">English</a> | <a href="README.zh-CN.md"><b>简体中文</b></a></p>

# Notification Grouper

把同一个发送应用的通知折叠进单个堆叠源的 GNOME Shell 扩展，而不是每个进程一个栈头。

![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-blue)
![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)
[![Repository](https://img.shields.io/badge/repository-GitHub-black?logo=github)](https://github.com/SHADE-glitch/notification-grouper)

GNOME 50。零配置——没有设置界面、没有规则文件、没有配置项。

## 📖 项目说明

**SHADE-glitch** 的**原创扩展**，不是分支，没有需要署名的上游项目。为 GNOME Shell
50 编写，在 GNOME Shell 50.1 / Ubuntu 26.04 上验证。整个扩展就是两个方法包装加一个
纯函数模块：没有设置界面、没有自己的 UI、不联网。

## ❓ 要解决的问题

GNOME 的 Freedesktop.org 通知后端按 `pid + app_name` 缓存来源。对长驻应用没问题。
但命令行或开发工具发一条通知就退出，**每次都是新 pid**，因此每次都是新来源——而且
这些来源永远不会被回收，因为清理路径只对能解析成真实 `Shell.App` 的发送方生效。

一轮构建 hook、CI 提醒和 agent 完成通知之后，通知中心里就是一整墙标题相同的栈头，
每个里面只有一张卡片。

本扩展让它们共用一个来源，键就是发送方声明的身份。

## 🚫 它不做什么

开 issue 前请先读这里——其中几条是有意为之。

- **能解析成 `Shell.App` 的应用通知完全不碰。** GNOME 原生已按应用分组，没有可修的，
  本扩展也不碰它们。
- **完全不声明名字的发送方不碰。** 分组键是发送方声明的身份，所以 `notify-send`、
  `node-notifier` 这类通用 `app_name` 照样按该名字分组——`notify-send` 一个栈，
  `node-notifier` 另一个栈。只有真正为空的 `app_name` 才算"这个发送方不表明身份"，
  交给原生按 pid 隔离。代价是：两个互不相关的工具都以裸 `notify-send` 发送时会共用
  一个栈。想区分就给发送方一个独立的 `--app-name`（或 `desktop-entry` hint）。
- **完全没有配置。** 按应用分支、规则文件、标题模式全部删除；引擎里不含任何应用名。
  分组完全是"发送方声明的身份"的纯函数。
- **不改 UI。** 图标、标题、横幅、紧急度、点击行为、原生每源 10 条上限，全部交给
  GNOME。本扩展不注入按钮，也不覆盖栈头。

## 🔬 工作原理

在 FDO 后端实例（`Main.notificationDaemon._fdoNotificationDaemon`）上包装两个方法：

| 挂载点 | 作用 |
| --- | --- |
| `NotifyAsync` | 在入口读 hints，算出分组，把结果暂存 |
| `_getSourceForPidAndName` | 消费暂存；返回共享来源，或落回原生 |

暂存只有一个槽位，这是安全的，因为 shell 侧的 `NotifyAsync` 是纯同步方法——读 hints
和解析来源之间没有 `await`，且该连接上的 D-Bus 分发不可重入。为防止这个假设被下游
补丁打破，暂存里还带了发送方 pid；如果两次调用看到的 pid 不一致，这条通知就原样落回
原生，并只记一条告警。

两个方法必须都存在才会挂载。缺任一个，扩展就完全惰性并只记一条告警——绝不半挂载。

`disable()` 会还原两个方法、断开各来源的 handler 并清空缓存。

### 分组键

先匹配者胜：

1. `desktop-entry` hint
2. 应用 id（留给 portal/Gtk 路径；FDO 路径极少有）
3. 归一化后的 `app_name`，只要非空就用——通用名也算

归一化是：去空白、转小写、去掉结尾的 `.desktop`。所以 `Foo`、` foo.desktop ` 和
`FOO` 会落到同一组。

热路径是纯函数，无正则、无文件 IO、无定时器。

## 🧩 兼容性

`shell-version` 只声明 `50`。这是两个挂载点及其行为被验证过的版本（GNOME Shell
50.1、Ubuntu 26.04）。48 和 49 看起来源码兼容，但没实际跑过，所以不声明支持。

注意 GNOME 自己的兼容检查**只比主版本号**，所以本扩展在 50.2、50.3 上会照常加载。
由于它依赖一个私有方法名，该方法可能在小版本里被改名。失败模式就是为此设计的：
扩展转为惰性并只记一行日志，而不是抛异常。

判断自己处于哪种情况：

```sh
journalctl --user -b | grep notification-grouper
```

正常：

```
[notification-grouper] enabled, attached patches: NotifyAsync, _getSourceForPidAndName
```

上游改名了——请带上这行开 issue：

```
[notification-grouper] WARNING degraded, staying inert: ...
```

## 🔒 隐私

- 通知**正文永不写入日志**，而且完全没有逐条通知的日志：启用一行、禁用一行。
- 不联网。不写文件。不持久化状态。唯一读取的就是每条通知里本来就有的、发送方声明的
  身份。

## 📥 安装

需要 Ubuntu 上的 GNOME Shell 50（已在 Ubuntu 26.04 + GNOME Shell 50.1 验证）。
无构建步骤，除 `git` 外无依赖。

```sh
# 1. 直接克隆进扩展目录
git clone https://github.com/SHADE-glitch/notification-grouper.git \
  ~/.local/share/gnome-shell/extensions/notification-grouper@local

# 2. 启用
gnome-extensions enable notification-grouper@local
```

也可以在**扩展**（Extensions）应用里启用。

**注销再登录**——这是加载新克隆扩展的可靠方式。开关一次**不会**重新加载改动过的
JavaScript：shell 按进程缓存 ES 模块，所以验证代码改动需要重启 shell。

### 卸载

```sh
gnome-extensions disable notification-grouper@local
rm -rf ~/.local/share/gnome-shell/extensions/notification-grouper@local
```

## 🔨 开发

```
extension.js       两个 daemon 包装、来源缓存、UI 兜底、enable/disable
groupEngine.js     纯函数：归一化、分组、挂载与兜底点自检
tests/             node 套件 + headless 运行时 harness
scripts/bench.mjs  引擎微基准
```

`groupEngine.js` 刻意不从 `gi://` 或 `Shell` 导入任何东西，所以同一份文件在 GJS 和
Node 下都能跑，分组逻辑无需真实会话即可测试：

```sh
npm test                   # 11 个纯函数用例
npm run bench              # 引擎吞吐
npm run verify:headless    # 对一次性 shell 做 12 项运行时断言
tests/headless-ui-guard.sh <目录> <标签>   # 逼出原生 collapse 缺陷
```

`npm test` **只**覆盖 `groupEngine.js`，完全执行不到 `extension.js`。两个 headless
harness 会起一个私有 GNOME Shell（`dbus-run-session` + `GSETTINGS_BACKEND=memory` +
独立 `XDG_DATA_HOME`），不会碰你的会话、配置或通知栏。
`tests/headless-ui-guard.sh` 对两份构建跑同一条断言，要求结果**翻转**——只在新代码上
亮绿灯的探针什么也证明不了。

harness 里也记下了那些实测才踩得到的坑：GNOME 50 拒绝符号链接的扩展目录（要复制）、
`--nested` 已被移除、`gdbus` 会把裸 `-1` 参数当选项、`GLib.spawn_async` 返回的是 pid
而不是子进程句柄。

`tests/fixtures/` 下的 JSON fixture 是用 `dbus-monitor` 从真实通知抓的。正文已清空、
D-Bus 总线名已替换为占位符；发送方 pid 刻意保留，因为"每次调用 pid 都不同"正是整个
扩展赖以成立的前提，fixture 是这件事的证据。

## 🩹 对 GNOME 50 通知列表缺陷的兜底

GNOME 50 自己的 `ui/messageList.js` 有一个竞态，会把通知列表**冻住——点什么都没反应**。
本扩展为此提供两处窄兜底。

为什么一个"分组"扩展要去动 shell 的 UI 代码：分组会把栈做大，而组变大正是让这个**既有
缺陷**变得可达的条件。原生按 `pid + app_name` 缓存来源，所以多数组只有 1 张卡，走不到
那条路径；合并把许多单卡组变成少数多卡组，暴露面就从接近零变成偶发。这是本功能的后果，
所以缓解它属于本扩展的分内事。

缺陷链条（均已核对 GNOME Shell 50.1 的行号）：

1. `_removeNotification` 在 `messageList.js:1161` 读 `item.layout_manager`，但真正删除
   Map 条目要等到 `:1170` 的动画回调里。于是 `:1161` 一旦抛出，`_notificationToMessage`
   里就永久留下一条**脏消息**。
2. 之后 `collapse()` 在 `:992` 遍历到它，`Message.unexpand`（`646`）调用
   `ease_property('@layout.expansion', …)`。
3. `_easeAnimatableProperty` 是**普通函数、不是 `async`**（`environment.js:196`），所以
   那个 `TypeError` 是同步抛出的，`:341` 的 `.catch()` 根本接不到。
4. `collapse()` 没有 `try/finally`，于是 `_expanded = false`（`:998`）和
   `_cover.show()`（`:1000`）永不执行。分组永久停在半折叠态，此后每次点击都被 `:1114` 的
   `if (!this.expanded)` 吞掉——这就是用户看到的"点什么都没反应"。

兜底做法：`Message.unexpand` 在 actor 已无 layout manager 时直接落终态返回（从而让循环
能把剩下的消息处理完），`NotificationMessageGroup.collapse` 在仍有异常抛出时强制把状态
落位。

两处兜底与分组**完全独立**：它们通过动态 `import()` 接入，所以某个 GNOME 版本改了
`messageList.js` 的名字，只会丢兜底，不会丢分组。这是在替上游的 bug 擦屁股——**上游修好
后请整段删掉**；若你在 journal 里看到 `UI guards degraded`，请提 issue。

### 你应该预期的点击行为（原生决定，不可配置）

- **折叠态里点一张卡不会激活它，只会展开整组。** `messageList.js:1114` 会中止点击事件的
  继续派发，把它转成一次展开请求。恰好只有 **1** 张卡的组被视同已展开（`:952`），这就是
  为什么原生那些小组看起来"点了就消失"。合并后的组是多卡组，所以请预期第一下点击只展开、
  展开后再点那张卡才执行动作。
- **解析不到应用的发送方，其通知永远不可能点击跳转。** `source.app` 为 null 时
  `openApp()` 第一行就 return，而本扩展负责的路径恰恰就是 `app` 为 null 的那条。点击是否
  会拉起什么，由**发送方**有没有提供 `default` action 决定
  （`notificationDaemon.js:232-241`），任何扩展都无法事后补上。
- 折叠组里点关闭按钮，关掉的是**整组**（`:1107`）。

## ⚠️ 已知限制

- **展开态（或单卡组）点一张卡片会关掉整个合并栈。** 这是原生 `Source.open()` 的行为
  （`destroyNonResidentNotifications()`）；跨进程合并把它的作用域从一个进程的卡片扩大到
  整组。为什么折叠组的第一次点击只展开，见上一节"你应该预期的点击行为"。
- **`desktop-entry` hint 指向不存在的 `.desktop` 文件时，分组键会和栈标题脱钩。**
  分组按 hint，标题按 `app_name`。这是窄场景——真实 GTK 应用会解析成 `App` 走原生
  路径——但两个应用共用这样的 hint 就会落进同一个栈。
- **禁用不会取消已合并的分组。** 启用期间合并的栈保持其内容；只有新到的通知回到按
  pid 的来源。
- 扩展 UUID 是 `notification-grouper@local`。

## 🤝 参与贡献

欢迎 issue 和 pull request。请保持改动聚焦，并在提 PR 前跑一遍[开发](#-开发)一节里
的测试套件。

## ⚖️ 许可证

GPL-2.0-or-later · `SPDX-License-Identifier: GPL-2.0-or-later`。见 [LICENSE](LICENSE)——该文件是逐字的 FSF 正文，所以 GitHub 自动识别只报 GPL-2.0；以上声明才是实际授予的许可。
