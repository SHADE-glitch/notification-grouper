# MAINTENANCE — notification-grouper@local 维护手册

**读取顺序**：`reports/STATE.md`（若存在，是本轮接续点，目录已 gitignore）→ `AGENTS.md`（规则）
→ 本文件（事实与手册）→ `CHANGELOG.md`（决定史）。

本文件只放**可复核的事实与固定流程**，不放规则（规则在 `AGENTS.md`），不放决定（在
`CHANGELOG.md`）。所有原生行号都是本机 GNOME Shell 50.1 上 `gresource extract` 出来的，
下面每一节都标注了核对日期；行号会随版本漂移，所以引用一律给**区间**而不是单行。

- 代码规模：`extension.js` 395 / `groupEngine.js` 159 / `uiWorkarounds.js` 206 /
  `prefs.js` 206 行（出厂代码合计 966 行；其余是测试与文档）。
- 原生 JS 不落盘在 `/usr/share/gnome-shell`，在 `/usr/lib/gnome-shell/libshell-18.so` 的
  gresource 里；子命令是 `extract`，不是 `show`。

```sh
gresource list /usr/lib/gnome-shell/libshell-18.so | wc -l        # 本机 160 条
gresource extract /usr/lib/gnome-shell/libshell-18.so \
  /org/gnome/shell/ui/messageList.js > /tmp/ml.js
```

## 不变量

违反任何一条都是 bug，不是风格问题。每条都注明"由谁守住"——没有守手的不变量等于没有。

- **三层补丁面每一层都必须 detach-before-capture，且 detach 在自己的 await 之后。**
  守手：L1 `double-enable restores pristine` / `re-attach after detach` /
  `guards restored to pristine`（原型层按**与 enable 前捕获的函数身份相等**判定，不按日志、
  不按行号、不按 `hasOwnProperty`）。历史：v4 只给 daemon 两层修了这条（D-005），另两层直到
  本轮才补上（F1）——递归 504 帧的事故当年只发生在 daemon 层，因为另外两层在二次 enable 时
  是**层叠**而不是自调用。
- **`enable()` 不得重置自己拥有的状态。** `_shared` / `_ownSources` 登记的是已经挂到别人
  对象上的覆盖与连接；重建它们＝没人能还原。守手：L1 `record survives re-enable`、
  `own-source survives re-enable`、`destroy handler detached`。
- **`disable()` 必须能撤销 `enable()` 做过的每一件事**，含四个 `changed::` handler 与自建
  合并源本身。守手：L1 `disable disconnects settings`、`disable drops the settings object`、
  `merged source destroyed on disable`、`native pid cache self-cleaned`。
- **削位绝不得把合并源清空。** 原生在源的最后一条通知被销毁时会 `this.destroy()` 整个源
  （`messageTray.js:569-570`），所以"push 之前先削到 cap-1"在 `cap=1` 时会让紧接着的原生
  `addNotification` 操作已 dispose 的对象。守手：L1 `cap=1 keeps one card, still one source`
  与 `no repeated extension.js frame`（后者的红正是那两条 Gjs-CRITICAL 的栈）。
- **零 timer、零周期任务**：结构性零空闲开销是这个扩展的成本模型。守手：L0
  `no timer or repeating source in the shipped code`（grep 全出厂 JS）。
- **热路径不做 IO、不用正则、不读设置**：设置读一次进内存，`changed::` 刷新。
  守手：`npm run bench`（吞吐，非断言）+ 代码审查。
- **降级按类别隔离**：daemon 两点缺任一 → 完全惰性；`messageList.js` 取不到 → 只丢兜底。
  守手：L0 `checkAttachPoints` / `checkUiGuardPoints` 单测 + L1 `patches installed on enable`。
- **Shell 进程不导入 Gtk/Gdk/Adw**（`prefs.js` 是唯一例外，它跑在独立 GTK4 进程里）。
  守手：L0 `no Gtk/Gdk import in the shell process…`，并且同一笔断言反向要求 `prefs.js`
  确实导入 Adw，否则这条守卫会被"重命名 prefs.js"悄悄废掉。
- **日志纪律**：无逐条通知日志、永不记 body；聚合数字由产出它的命令打印，绝不手抄进文档。
  守手：L0 `records carry no real application name`、文档审查。

## 三层验证边界

| 层 | 命令 | 环境 | 能证明 |
| --- | --- | --- | --- |
| L0 | `npm test`、`npm run check`、`npm run check:log` | 只有 Node | 纯函数行为、仓库级不变量、CHANGELOG 覆盖 |
| L0.5 | `npm run check:prefs` | `gjs` + libadwaita 内省，不起 shell | `prefs.js` 用到的每个 Adw/Gtk 成员在本机存在，且被禁用的成员没被用 |
| L1 | `npm run verify:headless`、`npm run verify:ui-guard`（两种 `EXPECT`）、`npm run verify:provoke` | 一次性 headless GNOME Shell（私有 D-Bus + `GSETTINGS_BACKEND=memory` + 私有 `XDG_DATA_HOME` + 独立 `--wayland-display`） | 补丁挂载与还原、合并语义、来源销毁、设置热应用、兜底是否真的拦住了原生缺陷、**削位告诉发送方的 reason 真的上了总线**（同总线另起 `dbus-monitor`） |
| L2 | `tests/smoke.sh` 清单，由用户在真实会话跑 | 用户桌面 | 真实发送方（CLI hook / systemd / 带 `--app-name` 的工具）的行为、观感、深浅色、prefs 对话框实际渲染 |

**L1 看不到什么**（写在这里是为了不要拿它当证据）：

- 真实功耗。headless 没有合成器上屏、没有 GPU 参与、没有屏幕刷新，测出来的 CPU/RSS 变化
  只能证明"没有额外常驻任务"，不能证明"省电"。
- 帧时钟与动画：`--headless --virtual-monitor` 不产生真实的 `stage` 绘制。
- **prefs 对话框本身**：`prefs.js` 跑在 D-Bus 激活的独立 GTK4 进程
  （`/usr/bin/gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions`），headless shell
  不启动它。控件属性能过 L0.5 的内省门，但"这一行在 1.9.1 上渲染成什么样""EntryRow 能不能
  接受输入"只能 L2 手看。
- 真实发送方的身份解析：headless 里所有通知都是 `notify-send` 这一类；能解析成 `Shell.App`
  的发送方根本不走被 patch 的那条路径。
- 跨小版本兼容性（只能在目标版本上重跑 L1 才知道）。

**L2 侧的三条仪器规矩**（每一条都对应一次真实的误读）：

- **要看发送方收到什么，必须起独立监听进程。** `NotificationClosed` 是 shell 自己广播的，
  而总线不会把广播信号送回给发送者，所以在 shell 进程里 `subscribe` 恒为空——那是一种
  "仪器根本没接上、看起来却像产品没问题"的绿。headless harness 已内置 `dbus-monitor`。
  另外：**在真实会话里抓到 reason 1 不能归因于削位**，普通超时的通知自然过期时读数完全相同；
  归因只在 L1 成立，因为那里的通知是 `urgency=critical`（不会自己消失，唯一来源就是削位）。
- **判断实况加载的是哪份代码，用起动时间对比 mtime**：
  `ps -o lstart= -p $(pgrep -x gnome-shell)` 与 `date -r extension.js`。不要用
  `gnome-extensions info`——它读的是磁盘 `metadata.json`，不反映已加载的类；disable/enable
  也不会重载 ES 模块。
- **通用串不能当产品判据。** `already disposed` 在 GNOME 里是通用串：实测一个 boot 有 5 条，
  全是 `St.Adjustment` / `Gjs_ui_layout_UiActor` 在换壳那一秒的噪声。我们那个缺陷的特征串
  带类名，判据必须写全 `notificationDaemon_FdoNotificationDaemonSource`（`smoke.sh` 已如此）。

## Shell 内部接口清单（50.1 实测，核对日期 2026-10-09）

`扩展处` 只写**符号锚**（函数名 / 被赋的值），不写本仓库的行号——本仓行号每一轮都漂，而符号名是
`npm test` 正在校验的东西（`every declared patch point is still named in the module that owns it`），漂了会红。
`原生处` 才是行号区间（我们控制不了它），并且**改任何一行之前先重跑上面那条 `gresource extract` 复核**，不要相信这张表仍然新鲜。

| # | 依赖 | 扩展处 | 原生处（50.1） | 性质 |
| --- | --- | --- | --- | --- |
| 1 | `Main.notificationDaemon._fdoNotificationDaemon` | `_attach()` 里读 `daemon._fdoNotificationDaemon` | `notificationDaemon.js:714` | 私有属性，无公共访问器 |
| 2 | `NotifyAsync(params, invocation)` | `_attach()` 里 `fdo.NotifyAsync = …`（`_detachPatches()` 还原） | 定义 `:135`；hints 读 `:166-167`；**同步**，整文件零 `async`/`await` | 私有方法；`_pending` 的单槽假设全系在这一行 |
| 3 | `_getSourceForPidAndName(sender, pid, appName)` | `_attach()` 里 `fdo._getSourceForPidAndName = …`（`_detachPatches()` 还原） | 定义 `:113`；原生自清 `_sourceForPidAndName` `:126-128` | 私有，三参签名 |
| 4 | hint `x-shell-sender-pid` / `x-shell-sender` / `desktop-entry` | `NotifyAsync` 包裹层内的 `read()` helper（取 `desktop-entry`、`x-shell-sender-pid`） | 由独立进程 `/usr/bin/gjs -m /usr/share/gnome-shell/org.gnome.Shell.Notifications` 注入（那一侧**是** async），shell 侧 `:166-167` 读 | 协议约定，不是 API |
| 5 | `FdoNotificationDaemonSource.open()` → `openApp()` + `destroyNonResidentNotifications()` | 自建源时 `source.open = patchedOpen`，`disable()` 里按 `rec.origOpen` 还原 | `notificationDaemon.js:370-373`（基类 `messageTray.js:612`）；`activated` 未提供 default action 时走 `source.open()` `notificationDaemon.js:232-241`（`:239`） | **实例属性**覆盖，只作用于自建源 |
| 6 | `Source` 的 `destroy` 信号 | 自建源时 `source.connect('destroy', …)`，id 存进 `_shared` 记录 | 声明 `messageTray.js:513`，发出 `:605` | 公共信号，是观察来源生命周期的唯一受支持方式 |
| 7 | `Source.destroy()` 的资源释放 | `disable()` 调用 | `messageTray.js:597-609`（`policy.destroy()` `:607`、`run_dispose()` `:608`）；`FdoNotificationDaemonSource.destroy()` `notificationDaemon.js:384-391` 先 `unwatch_name`，**且不转发 reason** | 禁用即销毁自建源的依据 |
| 8 | `Message.prototype.unexpand(animate)` | `attach()` 里 `Message.prototype.unexpand = …`（`detach()` 按 `_origUi` 还原） | `messageList.js:644`，其中 `:646` 的 `ease_property('@layout.expansion')` 就是 `ui/environment.js:196` 的**普通函数** `_easeAnimatableProperty` | 导出类的原型（动态 `import()`） |
| 9 | `NotificationMessageGroup.prototype.collapse()` | `attach()` 里 `Group.prototype.collapse = …`（`detach()` 还原） | `messageList.js:988-1009`：`forEach` `:992`、`_expanded=false` `:998`、`_cover.show()` `:1000`、唯一的 `.catch()` 在 `:1006`（循环之后，拦不到） | 同上 |
| 10 | `NotificationMessage.prototype.close` | `attach()` 里 `NotificationMessage.prototype.close = …`（`detach()` 还原） | **仅继承**：真身 `Message.close` `messageList.js:541`，`NotificationMessage` 无自有 `close`；默认处理器 `on_close` `:726` | 见 F5：上游动 `Message.close` 会连带影响这一层 |
| 11 | `Message._bodyBin` / `._expanded` / `Group._cover` / `expanded` getter | `uiWorkarounds.js` 内 | `messageList.js:512`、`:909`、`:904`、`:952`（单卡组报 `expanded===true`） | 私有字段，兜底的判据 |
| 12 | 折叠组里 close 升级为整组关闭 | 兜底的触发条件 | `messageList.js:1107-1112`（`signal_stop_emission` `:1110`、`this.close()` `:1111`）；点击被吞 `:1114-1119`（`if (!this.expanded)` `:1115`） | 已知上游行为，不是缺陷本身 |
| 13 | `MAX_NOTIFICATIONS_PER_SOURCE = 10` | `NATIVE_MAX_PER_SOURCE` 常量 + `_evictTo()` | `messageTray.js:25`，原生在 **push 之前**同步削位 `:577-579`，reason `EXPIRED`（枚举 `:48-53`） | 设置项 `max-per-source` 的上界来源 |
| 13b | **Source 在自己最后一条通知被销毁时自我销毁** | 决定了削位只能放在 push **之后** | `messageTray.js:569-570`：`if (!this._inDestruction && this.notifications.length === 0) this.destroy()` | 硬约束：`_evictTo(…, 0)` 会让随后原生的 `addNotification`（`:592`）操作已 dispose 的对象，实测 `Gjs-CRITICAL … has been already disposed`，栈为 `notificationDaemon.js:266 → :367 → messageTray.js:592` |
| 14 | destroy reason → FDO `NotificationClosed` | 不干预 | `notificationDaemon.js:178-195`（EXPIRED→1 / DISMISSED→2 / SOURCE_CLOSED→3 / 其它→4），发出 `:300-302` | `EXPIRED` 传错＝替用户"手动关闭"，见 `_evictTo` 注释 |
| 15 | `ExtensionBase.getSettings(schema)` | `_loadSettings()` 里的 `this.getSettings()` | `extensions/sharedInternals.js:92`；`metadata.json` 需 `settings-schema`；GNOME 50 **不再**自动编译扩展自带 schema（`extensionUtils.js`/`extensionSystem.js` 里零 `compile_schemas`） | 公共 API（扩展框架） |

**设置的一条实操注意**（本机实测）：扩展用的 schema 只存在于扩展目录的 `schemas/`，
`getSettings()` 是现场 `Gio.SettingsSchemaSource.new_from_directory(...)`（`sharedInternals.js:97-105`）
把它挂进去的。所以 `gsettings list-recursively <schema>` / `gsettings get` 这类 **CLI 工具看不见它**，
但写入的 dconf **路径**是同一个——要看真实会话里的取值，用
`dconf dump /org/gnome/shell/extensions/notification-grouper/`（只读）。这也意味着：
`GSETTINGS_BACKEND=memory` 下的 harness 写入不会落到这里，而任何在真实会话里跑的 `gsettings set`
**会**改到用户的实际配置——排障时别顺手敲。

## 兼容矩阵

| GNOME | 状态 | 依据 |
| --- | --- | --- |
| 50.1 / Ubuntu 26.04 | **已运行验证（R）** | 本文件全部锚点、L1 两套 harness、L0 全套 |
| 50.2+（同主版本） | 会照常加载，未验证 | GNOME 的兼容检查只比主版本号；风险集中在上表 #1/#3 两个私有方法名 |
| 48 / 49 | 看起来源码兼容，**不声明** | 未跑过；`shell-version` 故意不列 |
| 51+ | 未知 | 未发布前不猜；`checkAttachPoints` 会让它转为惰性并只记一行 |

失败模式是设计的一部分：上游改名 → 扩展完全惰性 + 一行 `WARNING degraded, staying inert`，
不抛异常、不丢通知；兜底取不到 → 只丢兜底，分组照常。

## 升级适配手册

新的小版本（或换了发行版）到手，按顺序做，不要跳步：

1. **取源码**：`gresource extract` 出 `notificationDaemon.js`、`messageTray.js`、
   `messageList.js`、`ui/environment.js`、`extensions/sharedInternals.js`。
2. **对上表逐条复核**，重点是三个致命项：`NotifyAsync` 是否仍是**同步**且无 `await`
   （#2，`_pending` 单槽全系于此）、`_getSourceForPidAndName` 的**三参签名**是否还在（#3）、
   `Source.destroy()` 是否仍释放 `policy` 与 `watch_name`（#7）。
   任一不成立 → 先改设计再改代码，不要"先跑起来看看"。
3. **跑 L1**：`npm run verify:headless`。全绿才允许谈兼容；有红先判"是实现坏了还是断言过时"，
   判据是断言的语义，不是它的颜色。
4. **跑兜底激发台**：`EXPECT=native`（关掉兜底的副本）与 `EXPECT=guarded` 必须给出**相反**
   结论。如果 native 模式不再复现缺陷，说明上游已经修了——那是好消息，按
   `uiWorkarounds.js` 头部的九文件清单整块删除兜底。
5. 只有第 3、4 步都绿了，才讨论放宽 `shell-version`；放宽范围只写实际跑过的版本。
6. **发布物单独过一遍 L1**：`npm run pack` 产出 zip（它自带内容完整性门禁），解包后
   `tests/headless-verify.sh <解包目录> bundle` 必须同样全绿。源码树绿 **不等于** zip 绿：
   GNOME 50 的 `gnome-extensions pack` 是 C 程序，只收固定文件名（`metadata.json` /
   `extension.js` / `prefs.js` / `stylesheet*.css`），拆出去的模块会被**静默丢掉且 exit 0**；
   schema 那边它只收 `schemas/<id>.gschema.xml`，而运行时 `new_from_directory()` 打开的是
   `schemas/gschemas.compiled`（实测：只有 .xml 时直接抛）。`--extra-source=schemas/x.compiled`
   会把它放在 zip 根目录（路径错＝没放），`--schema=schemas` 报 "Can't recursively copy
   directory" 后仍然 exit 0。所以这两件事由 `tests/pack.sh` 补齐并校验，名单漂移由 L0 守卫拦。
7. 每一步的结果写进 `reports/STATE.md`；结论性的行为变化进 `CHANGELOG.md`（`D-###`）。

## 功耗与泄漏的固定度量方法

**空闲开销**：结构上为零——没有 timer、没有 watch、没有重复任务；扩展只在通知到达时执行。
可执行的证明是 L0 的 grep 守卫（任何 `timeout_add`/`idle_add`/`setTimeout`/`setInterval`
出现在出厂 JS 里就直接失败），**不是**"看起来没动"。

**泄漏判据**（确定性，禁止用 GC 探测）：

- 信号：`GObject.signal_handler_is_connected(obj, id) === false`（本轮实测可用；
  `GLib.get_name_owner` 在 GJS **不存在**）。
- 每源覆盖：`obj.open === 原生函数`（身份比较），以及扩展自己的 `_shared.size === 0`。
- 原型层：与 enable 前捕获的函数身份相等。
- **禁止** `WeakRef` + `imports.system.gc()`：本机实测那样回收不到 GObject 包装，
  `deref()` 仍返回活对象——用它判泄漏会把真泄漏读成已修复。

**RSS 打点**（只做趋势参考，不是判据）：`tests/headless-verify.sh` 读 `/proc/self/statm`
第 2 页，打四个点——baseline → 通知爆发后 → 二次 enable 后 → 全部 disable 后——并原样打印
（第四个点在设置阶段提前抛异常时不会被采样，打印为 `(not sampled)`）。它**不参与任何断言、
不影响退出码**，因为同进程里字体、图标、GPU 缓存的噪声远大于扩展本体；把它当红色判据就是在
测量噪声。本轮实测值记在 `reports/VERIFY.md`。

**L2 才谈得上"省电"**：真实会话里的比较只能是"开着 vs 关着"两段各跑一段会话，看
`journalctl` 有无异常、通知列表有无卡顿；不要拿 headless 的数字冒充这个结论。

## 已知不修

这些都有记录、有代价分析，故意不动。别在它们上面"顺手优化"。

- **不重建 TTL / 清组按钮 / 组头标题覆盖**（D-003 保持）：那些是行为改写，不是分组。
- **`/proc` 反查发送方身份**：已否决（用户拍板）。分组能力的天花板是协议层——发送方不声明
  `app_name` 时按 pid 隔离是对的，唯一的修法是发送方自己带 `--app-name`。
- **上限提到 10 以上**：需要复制原生 `addNotification`（销毁旧条目 + 两处 connect + push +
  `countUpdated`），为一个低频收益多加第四个脆弱补丁点，不划算。写进了 README
  § What it does not do。
- **`_removeNotification` 的脏条目成因**（`messageList.js:1152/:1161/:1170`）：根因在上游，
  本扩展只在下游兜住它，不去重写原生删除路径。
- **三处兜底作为一个降级单元**（F5）：`NotificationMessage.prototype.close` 只是继承来的，
  上游一旦动 `Message.close`，会连带无关的两个 collapse 兜底一起降级。本轮**保留**这个耦合
  （拆开它需要每点独立捕获/独立还原，收益是理论性的），只把它写进清单；真出事故时按
  `uiWorkarounds.js` 头部清单整块删除。
- **`_pending` 的同步交接在跨发行版补丁下可能失效**：现有两道守卫（pid、`app_name`）落安全侧
  ——直通原生 + 一次性告警。没有把它改成 per-invocation 状态，因为那需要 await 语义，而
  `NotifyAsync` 现在没有。
- **prefs 控件的可用属性只过了内省门**（L0.5），渲染与交互是 M（需用户在真实对话框里确认）。
