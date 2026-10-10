# CHANGELOG — notification-grouper@local

Original extension, **no upstream**: there is no fork point to diff against, so the record
starts where the current architecture was settled rather than at a snapshot of someone
else's code.

Coverage: 257d84f..HEAD
Check with `npm run check:log`. Entries are `D-###`, monotonic, never reused.
An entry states what was true **as of its commit**, not current state: old entries are not
re-verified, and aggregate counts live in the checker's output, never in this file.

`revert` = a deliberate withdrawal of earlier work; dropping it is a decision, not a bug.
Known-but-not-fixed issues do **not** appear here (they have no commit) — see README
§ What it does not do and § Known limitations.

---

### D-001 · 2026-09-26 · revert · v2
Symptom  设置面依赖 libadwaita 的具体控件属性，1.9.1 上 `Adw.ButtonRow` / `EntryRow` 没有
         `subtitle`（`ddc3094` 实测撞上，当时改用 Group description 绕开）
Change   删除 `prefs.js` / `rules.json` / `rules.example.json` / `check-adw-props.py`，
         扩展改为零配置：无设置对话框、无规则文件、无 config key
Evidence L0 静态可证（HEAD 里这些文件不存在）；L1 2026-10-07 重跑全绿；L2 未验证
Cost     恢复它等于推翻"零配置"定位，不是恢复一段代码
Commit   257d84f

### D-002 · 2026-09-26 · revert · v2
Symptom  引擎带 `compileRules` 与 `sourceRules` / `blockRules` / `bodyPattern` / `urgency` /
         `groups` 等规则字段，成立的前提是有一整套规则文件与校验路径
Change   瘦身为 `normalizeName` + `computeGroup` + `checkAttachPoints` 三个纯函数，
         规则字段全部移除
Evidence L0 静态可证（HEAD 两个源文件里 `compileRules` 与 `rules` 均 0 命中）；
         L1 2026-10-07 重跑全绿；L2 未验证
Cost     与 D-001 同批：恢复规则能力等于恢复一个已被删除的设置面
Commit   e0872b3

### D-003 · 2026-09-26 · revert · v2
Symptom  扩展曾带第三个 daemon 补丁、清组按钮、TTL 过期、组头标题覆盖
Change   回到 2 个补丁 + 原生行为，上述四项删除，交还给 GNOME 原生
Evidence L1 2026-10-07 重跑全绿（其中 "native cached one pid per group" 仍在）；
         TTL 与组头覆盖在 HEAD 0 命中；L2 未验证
Cost     删掉的是功能不是缺陷，重新加回等于改变"只补丁、不改行为"的定位
Commit   2df3f29

### D-004 · 2026-09-29 · fix · v4
Symptom  FDO 后端按 `pid + app_name` 缓存 source；命令行与开发工具每次一个全新 pid，
         同一来源的通知散成一堆独立卡片。此前对通用 `app_name`（`notify-send` 等）直接放过
Change   分组键改为发送者**声明**的身份，声明了通用名的那批也参与分组
Evidence L1 2026-10-07 重跑全绿（"group keys as declared"、"3 same-name pids merged"）；
         L2 发送端 `-a` 曾实测有效（README § How it works）
Cost     边界要一起看：完全未声明名字的发送者仍然放过，本条只改变"声明了通用名"那一批
Commit   491f744

### D-005 · 2026-10-01 · fix · v4
Symptom  `enable()` 未先 `disable()` 时，第二次 `_attach()` 会把包装层本身当作原始方法捕获，
         形成 `wrapper2 -> wrapper1 -> wrapper1`；headless 实测复现为 `extension.js:141`
         的 504 层递归，该次运行里所有通知全部丢失
Change   `_attach()` 先调 `_detachPatches()` 再捕获 `_orig`，使 `_orig` 兼作
         "我当前是否已打补丁"的唯一标志
Evidence L1 2026-10-07 重跑全绿（"double-enable restores pristine"、"re-attach after detach"、
         "no wrapper recursion"）；L2 未验证
Cost     去掉幂等不会报错，只会静默丢通知；它与 `disable()` 的恢复逻辑不能分开改
Commit   f10a7ea

### D-006 · 2026-10-01 · fix · v4
Symptom  `_pending` 只用 `pid` 校验。同一发送进程连续发两条 `app_name` 不同的通知时 pid
         相同，会被并进错误的组并改写栈标题——pid 守卫看不见这种交错
Change   同时记录原始 `params[0]`；`_getSourceForPidAndName` 在两者不一致时落回原生路径
Evidence L1 2026-10-07 重跑全绿，但其中 "app_name guard silent" 是**负向断言**——它只证明
         正常情形不该触发，不证明触发时行为正确；journal 出现 `pending-appname-mismatch`
         即说明同步性假设已破；L2 未验证
Cost     删掉第二个字段校验不会报错，只会静默错合并，这是本条最难发现的地方
Commit   57f2661

### D-007 · 2026-10-07 · fix · v5
Symptom  GNOME 50.1 `messageList.js` 的 `_removeNotification` 在 :1161 读
         `item.layout_manager`，却在动画 `onComplete`（:1170）才删映射：中途抛错就留下孤儿消息。
         `collapse()`（:988）在 :992 遍历到它，`Message.unexpand`（:644）的 :646 调
         `ease_property('@layout.expansion')`，而 `ease_property` 就是普通非 async 函数
         `_easeAnimatableProperty`（ui/environment.js:196）⇒ `TypeError` 同步抛出，
         `collapse()` 虽是 `async` 却无 `try/finally`，抛出只把它自己的 promise 变成 rejected ⇒
         `_expanded = false`（:998）和 `_cover.show()`（:1000）不执行（方法里唯一的 `.catch()`
         在 :1006，属于循环**之后**那句 `ease_property_async`，拦不到这次抛出）⇒
         组永久半折叠，之后每次点击都被 :1114-1119 分支吞掉，托盘看起来是死的
Change   经动态 `import()` 取 `ui/messageList.js`，给 `Message.prototype.unexpand` 与
         `NotificationMessageGroup.prototype.collapse` 加兜底；只在
         `_bodyBin.layout_manager` 为 null（actor 已销毁）时改道；`disable()` 里连同两个
         daemon 补丁一起还原；`_attachUiGuards()` 在 `await` 之后检查 `_enabled` 才继续
Evidence L1 2026-10-07 `verify:ui-guard` PASS（`collapseThrewToCaller=false`、
         `coverShown=true`、`TypeError(obj is null)` 计数 0）；L2 未验证（折叠路径需真实会话）
Cost     上游修好后应整块删除——它是缺陷兜底不是功能。之所以由本扩展兜：分组让卡片变多，
         把一个原生几乎碰不到的缺陷变成偶尔可碰（README § Why an extension for grouping
         patches shell UI）
Commit   528b234

### D-008 · 2026-10-08 · fix · v7
Symptom  点一张没有 default action 的通知，原生 `FdoNotificationDaemonSource.open()` 先
         `openApp()`（本源 app 恒 null，实为 no-op）再 `destroyNonResidentNotifications()`，
         清空整个来源。原生按发送方缓存来源≈一张卡，看不见；跨 pid 合并把作用域放大成
         一整组，于是"点一张卡 -> 列表清空、日历停在空白页、整组消失"
Change   新建自建源时覆盖它的 `open()`，只保留 `openApp()`、去掉批量销毁；被点的那张仍由
         `Notification.activate()` 对非驻留通知的 `destroy()` 自行销掉。原生源不碰，
         `disable()` 按每记录 `origOpen` 还原（`source.open === rec.patchedOpen` 守卫防误
         还原）；`source.open` 非函数时只告警不拖累分组
Evidence L1 2026-10-08 `verify:headless` 全绿（新增 "merged source recognised"、
         "open() does not wipe the group"：调共享源 open() 后通知数不变）；L2 未验证
Cost     去掉覆盖即回到"点一张清整组"。它只作用于本扩展自建源，故删除它的代价仅限该场景
Commit   eb0a0fa

### D-009 · 2026-10-08 · taste · v7
Symptom  折叠组里点一张卡的 ×，原生 `messageList.js:1107-1112` 会把 close 升级成"关整组"。
         原生一个源≈一张卡时看不见，合并后代价放大
Change   仅当"本扩展自建源 + 组处于折叠态"时，改为直接跑 close 的默认处理器 `on_close()`
         （GJS 按 `on_<signal>` 自动接线，已实测确认），只关被点的那张；原生源、展开态、
         单卡组一律走原生路径
Evidence L1 2026-10-08 `verify:ui-guard` 同一 harness 对新旧构建翻转：折叠组关一张，
         pre-fix 3 -> 0（整组），post-fix 3 -> 2（只关一张）；L2 未验证
Cost     taste 级：删掉它只退回"点 × 关整组"，不构成 bug。之所以仍做，是它与 D-008 同源
         （合并放大原生 per-source 行为），一起改才自洽
Commit   eb0a0fa

### D-010 · 2026-10-09 · fix · v8
Symptom  `enable()` 的幂等**只对 daemon 两方法成立**。它在 attach 之前把 `_shared` /
         `_ownSources` 重建为空，而自建源的 `open()` 覆盖与每源 `destroy` 连接只登记在这些表里、
         只由 `disable()` 按记录还原：一次没有经过 disable 的二次 enable 就把它们永久孤儿化
         （`destroy` 闭包还捕获扩展实例本身），而 `_ownSources` 丢条目会让 close 兜底无声退回
         "关一张=关整组"。原型兜底另有一处：`detach()` 被调在它自己那个 `await` **之前**，
         等于没 detach
Change   删掉 `enable()` 里三行状态重置（只保留纯记账字段）；兜底的 detach 移到 await 之后、
         捕获之前；await 之后重新检查存活才允许挂
Evidence L1 2026-10-09 先红后绿：六条断言（record survives re-enable / own-source survives
         re-enable / merged open() restored / destroy handler detached / guards restored to
         pristine / disable log matches reality）在未修复树上全部 FAIL，修复后全部 PASS。
         实跑还证伪了我的静态估计：不是叠 2 层而是叠 4 层（4 次 enable → 4 行
         "UI guards attached"），且 `disable()` 打印出完整的"已还原三处兜底"**假报告**；
         L2 未验证（真实生效需要登出）
Cost     恢复任何一行重置都会重新引入孤儿补丁；这条与 `disable()` 的还原逻辑不能分开改
Commit   96ce1a0

### D-011 · 2026-10-09 · fix · v8
Symptom  `open()` 覆盖只去掉原生方法的**后半句**，所以还原成原生 `open()` 之后
         `destroyNonResidentNotifications()` 重新生效——"点一张卡清掉整组"回到**禁用之后**；
         同时每个自建源持有一个 `Gio.DBus.watch_name` 订阅和一个 `NotificationPolicy`，
         不销毁源就无人释放（真泄漏，且闭包链把扩展实例一起留住）
Change   `disable()` 在断开每源信号、按身份还原 `open()` 之后调用 `rec.source.destroy()`
Evidence L1 先加两条断言跑出 `FAIL merged source destroyed on disable` /
         `FAIL native pid cache self-cleaned`，再实现转绿；原生依据 `messageTray.js:597-609`
         （`policy.destroy()` + `run_dispose()`）与 `notificationDaemon.js:384-391`。
         顺带查明：`FdoNotificationDaemonSource.destroy()` 不接也不转发 reason，所以这些卡片
         以 `NotificationClosed` reason 4（`undefined`）发给发送方——已接受并写进 README，
         不为它加第三个补丁点；L2 未验证
Cost     代价是禁用瞬间已合并的栈整体消失（用户在 A/B/C 三案里明确选 B）；去掉 destroy 则
         同时收回"禁用后仍坏"的修复和泄漏的修复
Commit   96ce1a0

### D-012 · 2026-10-09 · guard · v8
Symptom  仪器绿而失明：递归判据 `extension\.js:1\d\d` 只匹配 100–199 行，而现行包裹体在 278/315
         之后——它守卫不到自己声称的代码；兜底还原与每源 `open()` 还原**没有任何断言**；
         还原判据在异步挂接完成前就执行，物理上看不见兜底层；`tests/headless-ui-guard.sh`
         零断言（只 cat JSON），要求的"翻转"靠人肉两次跑 diff，进不了门禁；信号泄漏、
         actor 残留、空闲开销完全无测量
Change   还原判据一律改为"与 enable 前捕获的原生函数**身份相等**"；泄漏判据用
         `GObject.signal_handler_is_connected` 与 own 属性（本机实测 `WeakRef` +
         `imports.system.gc()` 回收不到 GObject 包装，禁止当探针）；判定前先确认兜底已挂上；
         ui-guard 改为按 `EXPECT=guarded|native` 用退出码门禁；新增
         `tests/provoke-settings.sh` 变异台；RSS 打四个点且**只报告不断言**
Evidence 全部实跑：guarded 与 native 两侧各自全绿且结论相反（3->2 与 3->0）；变异台 6 个变异
         打出 6 条对应断言变红；三次运行 baseline 相差约 24 MiB（大于被测变化本身），这正是
         RSS 不进断言的理由。方法上的一条：`if (!flag)` → `if (false)` 那个变异存活，
         查明是**等价变异**（另一分支本来就先 detach），不是断言假绿——换成两处真实路径的
         变异后才红
Cost     判据退回日志文本、行号或 `hasOwnProperty` 就会在下一次行号漂移时集体失明；
         去掉变异台则"绿而失明"重新只能靠人肉发现
Commit   4c8c7f5

### D-013 · 2026-10-09 · chore · v8
Symptom  三处上游缺陷兜底与分组逻辑同住 `extension.js`（446 行），"上游修好后整块删除"没有
         删除单位；`NotificationMessage.prototype.close` 只是从 `Message.close` 继承来的，
         三者同生共死的降级耦合也没有登记处
Change   抽出 `uiWorkarounds.js`：`attach()` 自己先 detach（来回拨开关不叠层）、await 后检查
         存活、头部写清删除时要一起动的 9 个文件；`repo.test.mjs` 加"兜底不得爬回
         extension.js"与"补丁点必须住在拥有它的模块里"两条守卫
Evidence L1 断言一字未改仍全绿（这就是"行为未变"的证明）；L0 守卫存在且能红；
         L2 未验证
Cost     拆回去只是回到"同一个文件里的三段注释"，不改变任何行为——所以记 chore 而不是 guard
Commit   96ce1a0

### D-014 · 2026-10-09 · revert · v8
Symptom  D-001 / D-002 删掉了 prefs 与规则引擎，代价是用户无法关掉分组、无法收紧每组条数、
         无法让某个应用保持独立栈——本轮要的正是这三项（折叠行为、每组上限、按应用例外）
Change   新增 4 键 schema（`grouping-enabled` / `max-per-source` 1..10 / `ui-guards` /
         `isolate-apps`）+ Adw 设置页 + 热应用；四个 `changed::` id 全部登记并在 `disable()`
         逐个 disconnect。**推翻的只是"完全没有设置面"这一条**：不恢复规则文件、不恢复
         标题/紧急度匹配（D-002 删掉的匹配能力仍然删除），D-003 的四项（第三补丁点、清组
         按钮、TTL、组头标题覆盖）保持删除。默认值等于扩展原有行为，零配置继续开箱即用；
         上限以原生 `MAX_NOTIFICATIONS_PER_SOURCE` 为上界，只允许收紧
Evidence L1 设置阶段全绿，且每个键都有变异对照（cap / grouping / isolate / ui-guards /
         disconnect 各打红一条对应断言）；L0 `npm run check:prefs` 内省门过
         （libadwaita 1.9.1：`EntryRow` 无 `subtitle`、`SpinRow` 无 `value-changed`，
         int 键不能 bind 到 double 的 `value`）。**L2 未验证：对话框的实际渲染与交互是 M**
Cost     恢复"零设置"就是推翻本轮决定；schema 键一经发布即公开 API，不得改名也不得改类型；
         `.xml` 与 `.compiled` 必须同笔提交（GNOME 50 不再替扩展编译 schema）
Commit   96ce1a0

### D-015 · 2026-10-09 · fix · v8
Symptom  `groupEngine.js` 注释写"不丢消息"，与原生每源 10 条**同步销毁最旧**
         （`messageTray.js:25`、`:577-580`）直接矛盾——合并把"一个源"从一个进程变成一个应用，
         这个上限的作用域被放大；文档里的 `12/12`、`14/14`、"`npm test` 11 例"是手抄且已漂；
         README 的"禁用不会取消已合并的分组"在 D-011 之后是假的；缺陷链把抛错归给
         "`.catch()` at `:341`"，而那行其实是 `this._updateText()`
Change   如实改写上限语义（只下调、不阻止原生丢卡）；原生行号统一改区间
         （`:1107-1112`、`:1114-1119`，`.catch()` 在 `:1006` 且属于循环**之后**那句
         `ease_property_async`，结构上拦不到 `:992` 的抛出）；删除所有手抄聚合数字，改由
         产出它的命令打印；README 双语补「设置」与「排障」两节并改掉禁用语义；
         fixture 去掉真实应用名并改名
Evidence 全部原生锚点于 2026-10-09 用 `gresource extract /usr/lib/gnome-shell/libshell-18.so`
         逐行重读；README 双语节数由 L0 守卫比对；L0 全绿。文档正文本身在写下这条记录的
         同一笔文档 commit 里
Cost     手抄数字留着就是"绿而失明"的文档版；`.catch()` 归属写错会把下一个人引向去 patch
         一条根本接不到异常的 promise
Commit   96ce1a0, 4c8c7f5

### D-016 · 2026-10-10 · fix · v9
Symptom  把 `max-per-source` 设成 1 时实测 `Gjs-CRITICAL: Object
         Gjs_ui_notificationDaemon_FdoNotificationDaemonSource … has been already
         disposed`，栈为 `notificationDaemon.js:266 → :367 → messageTray.js:592`，
         我们包装 `NotifyAsync` 的那一帧就在其下。根因是削位时机：原生在源的最后一条通知
         被销毁时会**自我销毁**（`messageTray.js:569-570`
         `if (!this._inDestruction && this.notifications.length === 0) this.destroy()`），
         而我们在原生 push 之前削到 cap-1 —— cap=1 就是清空。cap>=2 削完仍留至少一条，
         所以默认值 10 与设置页上的多数取值都没有症状，只有端点 1 会踩
Change   削位改到原生 push **之后**：`_getSourceForPidAndName` 不再削位，只把接管的源登记到
         `_pending.servedSource`；`NotifyAsync` 包裹层在 `_orig.notify.call` 返回后
         （该路径同步，通知此时已进源）削到 cap。可见条数仍是精确的 cap，而 keep 恒 >= 1，
         两处调用点（push 后与设置调小时）都不可能把源清空
Evidence L1 40/40，日志里 `already disposed` 计数 0；新增端点与 reason 断言
         （cap=1 留一张且仍是一个源、cap=10 与原生上界一致、被削掉的卡片 reason 是
         EXPIRED(1) 而不是 DISMISSED(2)）；`npm run verify:provoke` 7 个变异全部打出各自
         的红灯，包含新增的 post-push-trim-removed。
         过程记录：第一轮修复只做了一半（加了 push 后的削位却没删 push 前的削位，
         `servedSource` 从未被赋值），正是新加的那条变异打不红暴露了它——
         断言对着一条空转的代码路径当然恒绿。L2 未验证（当前会话加载的仍是修复前的代码）
Cost     回到 push 前削位就只在 cap=1 时复发，且只在真实触发第 11 次削位时才打日志，
         是典型的"默认值看不出问题"的缺陷；探针侧同时改掉了事后读取已销毁包装的写法——
         那条 critical 本来是仪器自己造成的，它一度被当成产品缺陷的读数
Commit   b09e179
