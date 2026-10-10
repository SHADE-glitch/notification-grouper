<p align="right"><a href="README.md">English</a> | <a href="README.zh-CN.md"><b>简体中文</b></a></p>

# Notification Grouper

把同一个发送应用的通知折叠进单个堆叠源的 GNOME Shell 扩展，而不是每个进程一个栈头。

![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-blue)
![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)
[![Repository](https://img.shields.io/badge/repository-GitHub-black?logo=github)](https://github.com/SHADE-glitch/notification-grouper)

GNOME 50。开箱即用——默认值就是全部设计意图，你不必配置任何东西。真想改行为时有四个
白话开关；没有规则文件，也没有需要学习的配置格式。

## 📖 项目说明

**SHADE-glitch** 的**原创扩展**，不是分支，没有需要署名的上游项目。为 GNOME Shell
50 编写，在 GNOME Shell 50.1 / Ubuntu 26.04 上验证。shell 侧代码是通知守护进程上的两个
方法包装、对自己创建的来源的一处行为覆盖，以及一个自包含的缺陷兜底模块；分组本身是一个
纯函数模块。它不在通知列表里画任何自己的 UI，也不联网。

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
- **没有规则引擎。** 分组逻辑里的按应用分支、规则文件、标题模式全部删除；引擎不含任何
  应用名。分组完全是"发送方声明的身份"的纯函数。还能配的只有四个开关
  （[设置](#-设置)），它们都不会把匹配能力带回来：唯一能填的表就是"这些名字别合并"。
- **每堆卡片数只能往下调，不能往上调。** GNOME 每个来源最多留 10 条
  （`messageTray.js:25`，超出后在 `:577-580` 同步销毁最旧那条）。`max-per-source` 可以设
  1..10；再往上就等于重写原生 `addNotification`，也就是多第四个脆弱挂载点，所以有意不提供。
  合并对这个上限的影响见[已知限制](#-已知限制)。
- **不改 UI。** 图标、标题、横幅、紧急度全部交给 GNOME。本扩展不注入按钮，也不覆盖栈头。
  唯一的点击行为差异是下面["你应该预期的点击行为"]
  (#你应该预期的点击行为原生决定不可配置)里那两处窄例外——都**只作用于本扩展自己
  创建的栈**。

## 🔬 工作原理

在 FDO 后端实例（`Main.notificationDaemon._fdoNotificationDaemon`）上包装两个方法：

| 挂载点 | 作用 |
| --- | --- |
| `NotifyAsync` | 在入口读 hints，算出分组，把结果暂存 |
| `_getSourceForPidAndName` | 消费暂存；返回共享来源，或落回原生 |

两个方法必须都存在才会挂载。缺任一个，扩展就完全惰性并只记一条告警——绝不半挂载。

### 合并来源的点击行为

原生 `FdoNotificationDaemonSource.open()` 做两件事：先激活所属应用，再调用
`destroyNonResidentNotifications()` —— 后者会销毁该来源里**所有**非驻留通知。原生按
发送方缓存一个来源，所以一个来源几乎总是只有一张卡，这个批量销毁看不出来。合并把这个
来源变成了整组，于是同一次调用会清空整组：点一张无处可跳的卡，列表被清空、日历却还开着
——一片空白，组也没了。

因此本扩展**覆盖了自己创建的来源的 `open()`**（且只覆盖这些）：保留激活应用那半句，
去掉批量销毁。被点的那张仍会自己消失，因为 `Notification.activate()` 会对非驻留通知
调用 `destroy()`。净效果：点一张卡就只删那一张。

关闭路径同理：在**折叠**组里关一张卡，原生会关掉整组（`messageList.js:1107-1112` —— 一个
"每来源"的行为，组变大后才显现）。本扩展把它改成"只关这张卡"，同样只对折叠态且来源由
本扩展创建的组生效。

两处都严格限定于本扩展创建的栈；原生来源与展开态的组保持原生行为。详见
["你应该预期的点击行为"](#你应该预期的点击行为原生决定不可配置)与[已知限制](#-已知限制)。

暂存只有一个槽位，这是安全的，因为 shell 侧的 `NotifyAsync` 是纯同步方法——读 hints
和解析来源之间没有 `await`，且该连接上的 D-Bus 分发不可重入。为防止这个假设被下游
补丁打破，暂存里还带了发送方 pid；如果两次调用看到的 pid 不一致，这条通知就原样落回
原生，并只记一条告警。

`disable()` 会还原两个方法、每个被覆盖来源的 `open()`、断开各来源与设置的 handler、清空
缓存，并**销毁本扩展自建的合并来源**。最后这步不是收尾洁癖：这种来源持有的是一个 D-Bus
名字订阅加一个通知策略，两者只有 `Source.destroy()` 才释放（`messageTray.js:597-609`）；
更关键的是 `open()` 还原成原生版本之后再留着它，"点一张卡丢掉整组"就会回到"禁用之后"。
所以禁用即撤销本扩展造成的全部状态，详见[已知限制](#-已知限制)。

### 分组键

先匹配者胜：

1. `desktop-entry` hint
2. 应用 id（留给 portal/Gtk 路径；FDO 路径极少有）
3. 归一化后的 `app_name`，只要非空就用——通用名也算

归一化是：去空白、转小写、去掉结尾的 `.desktop`。所以 `Foo`、` foo.desktop ` 和
`FOO` 会落到同一组。

热路径是纯函数，无正则、无文件 IO、无定时器。

## ⚙️ 设置

在**扩展**（Extensions）应用里打开，或者：

```sh
gnome-extensions prefs notification-grouper@local
```

所有设置**立即生效**——不需要先禁用再启用，也不需要注销。页面上有一个动作把四个键一次性
恢复默认。

| 设置 | 键 | 默认 | 作用 |
| --- | --- | --- | --- |
| 按发出应用分组 | `grouping-enabled` | 开 | 关掉就是原样回到 GNOME：每个发送进程一个栈。 |
| 每堆保留卡片数 | `max-per-source` | 10 | 一个合并栈在**丢掉最旧那张**之前保留几张卡。范围 1..10；上限就是 GNOME 自己的数，所以只能往下调。 |
| 兜底 GNOME 通知列表的两处缺陷 | `ui-guards` | 开 | 即[兜底一节](#-对-gnome-50-通知列表缺陷的兜底)说的那两处行为。只在你想要拿未打补丁的 GNOME 做对比时才关。 |
| 不合并的应用 | `isolate-apps` | 空 | 这里列出的名字永不合并。匹配用的是真正拿来做分组键的那个身份，先去空白、再转小写，结尾的 `.desktop` 忽略。 |

取值存放在 dconf 的 `org.gnome.shell.extensions.notification-grouper` 下；扩展在启用时读
一次、之后每次变更读一次，通知热路径上不做任何读取。默认值就是上文描述的行为，所以新装的
用户一个键都不用碰。

两个要说清的头：

- 把**按发出应用分组**关掉不会拆开已经合并的栈，只是不再让新通知加进去。要拆掉它们得靠禁用
  扩展。
- `max-per-source` 只作用于本扩展创建的栈。调小会**当场**修剪现有堆叠——这是有意的，改动不用
  等下一条通知才看得见。

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

- 通知**正文永不写入日志**，而且完全没有逐条通知的日志：启用一行、禁用一行，拨动开关
  时再记一两行。
- 不联网。扩展自己不写文件，除你在设置页改的那四个键（存在 dconf，GNOME 的标准位置）之外
  不留任何状态——卸载或 `dconf reset` 就干净了。每条通知里唯一读取的就是发送方本来就声明的
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
JavaScript：shell 按进程缓存 ES 模块，所以验证代码改动需要重启 shell。（设置不是代码，
它们是即时生效的，见[设置](#-设置)。）

编译产物 `schemas/gschemas.compiled` 已随仓库提交，所以克隆后**什么都不用生成**；GNOME 50
不再替扩展自动编译 schema。

### 卸载

```sh
gnome-extensions disable notification-grouper@local
rm -rf ~/.local/share/gnome-shell/extensions/notification-grouper@local
```

## 🔨 开发

```
extension.js       daemon 两处包装、合并来源缓存、设置、enable/disable
groupEngine.js     纯函数：归一化、分组、挂载点与兜底点自检
uiWorkarounds.js   GNOME 缺陷兜底，独立成一个可整块删除的文件
prefs.js           设置页（独立 GTK 进程，shell 永不加载它）
schemas/           gsettings schema；gschemas.compiled 已入库，无构建步骤
tests/             node 套件 + headless 运行时 harness
scripts/bench.mjs  引擎微基准
```

`groupEngine.js` 刻意不从 `gi://` 或 `Shell` 导入任何东西，所以同一份文件在 GJS 和
Node 下都能跑，分组逻辑无需真实会话即可测试：

```sh
npm test                   # 引擎单测 + 仓库级守卫，不需要 shell
npm run check              # 对全部出厂 JS 做 node --check
npm run bench              # 引擎吞吐
npm run check:prefs        # prefs.js 只能用本机确实存在的 Adw/Gtk 成员（gjs）
npm run verify:headless    # 一次性 shell 里的运行时断言，条数由它自己打印
npm run verify:ui-guard    # 逼出原生缺陷，结论必须在两份构建之间**翻转**
npm run verify:provoke     # 在 /tmp 副本里逐个把设置路径改坏，每条都必须打红一项断言
```

上面这些命令的断言条数**刻意不写进本文**：手抄的总数加一条断言就过期，而过期之后的绿色数字
看起来像证据，其实是噪声。两个 harness 各自打印自己的条数。

`npm test` 覆盖引擎和仓库，**不**覆盖运行时行为：真正执行 `extension.js` 的只有
`tests/headless-verify.sh`。两个 headless harness 会起一个私有 GNOME Shell
（`dbus-run-session` + `GSETTINGS_BACKEND=memory` + 独立 `XDG_DATA_HOME`），不会碰你的
会话、配置或通知栏。`tests/headless-ui-guard.sh` 对两份构建跑同一条断言，要求结果**翻转**
——只在新代码上亮绿灯的探针什么也证明不了。

harness 里也记下了那些实测才踩得到的坑：GNOME 50 拒绝符号链接的扩展目录（要复制）、
`--nested` 已被移除、`gdbus` 会把裸 `-1` 参数当选项、`GLib.spawn_async` 返回的是 pid
而不是子进程句柄，以及 `WeakRef` 不能用来查泄漏——GJS 不会按需回收 GObject 包装。

`tests/fixtures/` 下的 JSON fixture 是用 `dbus-monitor` 从真实通知抓的。正文已清空、
D-Bus 总线名替换为占位符、应用名替换为通用名；发送方 pid 刻意保留，因为"每次调用 pid
都不同"正是整个扩展赖以成立的前提，fixture 是这件事的证据。

## 🧪 测试

`npm test` 是离线门，不需要 shell：引擎单测（`tests/test-groupEngine.mjs`）加仓库级守卫
（`tests/repo.test.mjs` —— 中英文档成对、零定时器 grep、挂载点归属、shell 进程内无 Gtk、
记录不含应用名、`reports/` 未被跟踪）。`npm run check` 与 `npm run check:prefs` 是静态与
gjs 检查；`npm run check:log` 是 CHANGELOG 覆盖率门。

运行时 harness 会起一个私有 GNOME Shell，**刻意不进 CI**：`npm run verify:headless`、
`npm run verify:ui-guard`、`npm run verify:provoke`（各自证明什么见
[开发](#-开发)）。每条命令各自打印自己的条数，本文不抄写。

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
3. `ease_property()` **就是** `_easeAnimatableProperty`，一个普通函数、**不是 `async`**
   （`ui/environment.js:196`），所以那个 `TypeError` 是在遍历里同步抛出的。
4. `collapse()` 是 `async` 却没有 `try/finally`，抛出只会让它返回一个被拒绝的 promise：
   `_expanded = false`（`:998`）和 `_cover.show()`（`:1000`）永不执行。方法里唯一的
   `.catch()`（`:1006`）属于 `collapse()` **自己那句在循环之后的** `ease_property_async`，
   拦不到这次抛出；调用方如果没 `await collapse()`，就只在 journal 里留下一条 JS ERROR。
   分组永久停在半折叠态，此后每次点击都被 `:1114-1119` 的 `if (!this.expanded)` 吞掉——
   这就是用户看到的"点什么都没反应"。

兜底做法：`Message.unexpand` 在 actor 已无 layout manager 时直接落终态返回（从而让循环
能把剩下的消息处理完），`NotificationMessageGroup.collapse` 在仍有异常抛出时强制把状态
落位。

两处兜底与分组**完全独立**：它们通过动态 `import()` 接入，所以某个 GNOME 版本改了
`messageList.js` 的名字，只会丢兜底，不会丢分组。这是在替上游的 bug 擦屁股——**上游修好
后请整段删掉**；若你在 journal 里看到 `UI guards degraded`，请提 issue。

它们住在 `uiWorkarounds.js` 里，那个文件加上它自己的 harness 就是完整的删除单元。在上游
修好之前，**兜底 GNOME 通知列表的两处缺陷**这个开关可以随时把它们关掉，用来和未打补丁的
GNOME 对比。

### 你应该预期的点击行为（原生决定，不可配置）

- **折叠态的多卡组里点一张卡不会激活它，只会展开整组。** `messageList.js:1114-1119` 会中止
  点击事件的继续派发，把它转成一次展开请求。恰好只有 **1** 张卡的组被视同已展开
  （`:952`），这就是为什么原生那些小组看起来"点了就消失"。合并后的组是多卡组，所以请
  预期第一下点击只展开、展开后再点那张卡才执行动作。
- **展开态里点一张卡不再清空整组。** 在本扩展覆盖之前，`Source.open()` 会清空整个来源；
  现在只移除被点的那张，组里其余的保留（见[合并来源的点击行为](#合并来源的点击行为)）。
- **解析不到应用的发送方，其通知永远不可能点击跳转。** `source.app` 为 null 时
  `openApp()` 第一行就 return，而本扩展负责的路径恰恰就是 `app` 为 null 的那条。点击是否
  会拉起什么，由**发送方**有没有提供 `default` action 决定
  （`notificationDaemon.js:232-241`），任何扩展都无法事后补上。
- **点一张卡的关闭按钮现在只关这张卡**，折叠的合并组里也是如此（原生在那里会关整组）。

## ⚠️ 已知限制

- **折叠的合并组第一下点击只展开**（原生 `:1114-1119`）；动作在第二下点击才触发。除非重写
  点击处理，这一点无法避免，且与原生多卡栈的行为一致。
- **合并栈会比 GNOME 更早丢掉最旧那张卡。** GNOME 每个来源最多留 10 条，第 11 条到达时
  同步销毁最旧那条（`messageTray.js:25`、`:577-580`，reason `EXPIRED`）。原生来源差不多
  就是一张卡，所以几乎丢不到东西；合并把一个应用的卡片全放进同一个来源，于是一个**话多的
  应用**发到第 10 张时，第 1 张就没了。本扩展不额外丢任何通知，也拦不住原生丢——拦它等于
  重写 `addNotification`。所以 `max-per-source` 只能往小调；真被某个发送方刷屏，在它自己
  那边静音比在这里过滤更合适。
- **`desktop-entry` hint 指向不存在的 `.desktop` 文件时，分组键会和栈标题脱钩。**
  分组按 hint，标题按 `app_name`。这是窄场景——真实 GTK 应用会解析成 `App` 走原生
  路径——但两个应用共用这样的 hint 就会落进同一个栈。
- **禁用会把合并栈拆掉。** `disable()` 会销毁本扩展自建的来源，里面还没看完的卡片随之
  退休。这是有意的：那种来源持有的 D-Bus 名字订阅与通知策略只有 `destroy()` 才释放，而且
  `open()` 还原成原生版之后再留着它，就等于把本扩展要修的那个 bug 放回"禁用之后"。原本
  就在**原生栈**里的通知完全不受影响。想要温和一点就关**按发出应用分组**：不再有新通知并
  进来，已有的栈保持不动。
- **因为"禁用"而退休的那些卡片，发给发送方的 `NotificationClosed` reason 是 4（`undefined`）**，
  不是"来源已关闭"。原生 `FdoNotificationDaemonSource.destroy()` 本身不接参数、`super.destroy()`
  也不带 reason（`notificationDaemon.js:384-391`），reason 在映射之前就被丢掉了；要改只能
  再 patch 第三个方法，为一条多数发送方并不关心的信号不值得。**被每堆上限削掉的卡片不是这样**：
  它们保持 `EXPIRED`，FDO 层把它报成 reason 1（`notificationDaemon.js:178-195`）——而且
  headless harness 是在总线上用一个独立观察者断言这个读数的，不只是在 shell 进程里取值。
- 扩展 UUID 是 `notification-grouper@local`。

### 排障

先看 journal；这个扩展在没有值得说的话的时候是安静的。

```sh
journalctl --user -b | grep -i notification-grouper
```

- **完全不合并，还是每个进程一个栈。** 多半是发送方根本没声明身份。真正为空的 `app_name`
  是有意交给原生的。让发送方带上 `--app-name`（或 `desktop-entry` hint）它就变成可合并的。
- **两个互不相关的工具挤在同一个栈。** 它们都用 `notify-send` 这类通用名发送。把其中一个
  加进**不合并的应用**。
- **`WARNING degraded, staying inert`。** GNOME 改了本扩展包装的两个 daemon 方法之一。
  请带着这一行开 issue；修好之前分组是关着的。
- **`UI guards degraded` / `UI guards attach failed`。** 取不到 `ui/messageList.js`，于是
  只缺缺陷兜底，分组照常。如果你那个 GNOME 版本已经没有底层缺陷，这行是预期且无害的。
- **禁用之后通知列表还是卡死了。** 那正是 GNOME 自身的缺陷；兜底就是拦它的，重新启用扩展
  （兜底已经开着还这样的话请上报）。

## 🤝 参与贡献

欢迎 issue 和 pull request。请保持改动聚焦，并在提 PR 前跑一遍[开发](#-开发)一节里
的测试套件。

## ⚖️ 许可证

GPL-2.0-or-later · `SPDX-License-Identifier: GPL-2.0-or-later`。见 [LICENSE](LICENSE)——该文件是逐字的 FSF 正文，所以 GitHub 自动识别只报 GPL-2.0；以上声明才是实际授予的许可。
