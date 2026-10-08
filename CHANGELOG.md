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
Evidence L0 静态可证（HEAD 里这些文件不存在）；L1 2026-10-07 重跑 12/12；L2 未验证
Cost     恢复它等于推翻"零配置"定位，不是恢复一段代码
Commit   257d84f

### D-002 · 2026-09-26 · revert · v2
Symptom  引擎带 `compileRules` 与 `sourceRules` / `blockRules` / `bodyPattern` / `urgency` /
         `groups` 等规则字段，成立的前提是有一整套规则文件与校验路径
Change   瘦身为 `normalizeName` + `computeGroup` + `checkAttachPoints` 三个纯函数，
         规则字段全部移除
Evidence L0 静态可证（HEAD 两个源文件里 `compileRules` 与 `rules` 均 0 命中）；
         L1 2026-10-07 重跑 12/12；L2 未验证
Cost     与 D-001 同批：恢复规则能力等于恢复一个已被删除的设置面
Commit   e0872b3

### D-003 · 2026-09-26 · revert · v2
Symptom  扩展曾带第三个 daemon 补丁、清组按钮、TTL 过期、组头标题覆盖
Change   回到 2 个补丁 + 原生行为，上述四项删除，交还给 GNOME 原生
Evidence L1 2026-10-07 重跑 12/12（其中 "native cached one pid per group" 仍在）；
         TTL 与组头覆盖在 HEAD 0 命中；L2 未验证
Cost     删掉的是功能不是缺陷，重新加回等于改变"只补丁、不改行为"的定位
Commit   2df3f29

### D-004 · 2026-09-29 · fix · v4
Symptom  FDO 后端按 `pid + app_name` 缓存 source；命令行与开发工具每次一个全新 pid，
         同一来源的通知散成一堆独立卡片。此前对通用 `app_name`（`notify-send` 等）直接放过
Change   分组键改为发送者**声明**的身份，声明了通用名的那批也参与分组
Evidence L1 2026-10-07 重跑 12/12（"group keys as declared"、"3 same-name pids merged"）；
         L2 发送端 `-a` 曾实测有效（README § How it works）
Cost     边界要一起看：完全未声明名字的发送者仍然放过，本条只改变"声明了通用名"那一批
Commit   491f744

### D-005 · 2026-10-01 · fix · v4
Symptom  `enable()` 未先 `disable()` 时，第二次 `_attach()` 会把包装层本身当作原始方法捕获，
         形成 `wrapper2 -> wrapper1 -> wrapper1`；headless 实测复现为 `extension.js:141`
         的 504 层递归，该次运行里所有通知全部丢失
Change   `_attach()` 先调 `_detachPatches()` 再捕获 `_orig`，使 `_orig` 兼作
         "我当前是否已打补丁"的唯一标志
Evidence L1 2026-10-07 重跑 12/12（"double-enable restores pristine"、"re-attach after detach"、
         "no wrapper recursion"）；L2 未验证
Cost     去掉幂等不会报错，只会静默丢通知；它与 `disable()` 的恢复逻辑不能分开改
Commit   f10a7ea

### D-006 · 2026-10-01 · fix · v4
Symptom  `_pending` 只用 `pid` 校验。同一发送进程连续发两条 `app_name` 不同的通知时 pid
         相同，会被并进错误的组并改写栈标题——pid 守卫看不见这种交错
Change   同时记录原始 `params[0]`；`_getSourceForPidAndName` 在两者不一致时落回原生路径
Evidence L1 2026-10-07 重跑 12/12，但其中 "app_name guard silent" 是**负向断言**——它只证明
         正常情形不该触发，不证明触发时行为正确；journal 出现 `pending-appname-mismatch`
         即说明同步性假设已破；L2 未验证
Cost     删掉第二个字段校验不会报错，只会静默错合并，这是本条最难发现的地方
Commit   57f2661

### D-007 · 2026-10-07 · fix · v5
Symptom  GNOME 50.1 `messageList.js` 的 `_removeNotification` 在 :1161 读
         `item.layout_manager`，却在动画 `onComplete`（:1170）才删映射：中途抛错就留下孤儿消息。
         `collapse()`（:992）遍历到它，`Message.unexpand`（:646）调
         `ease_property('@layout.expansion')`，而 `_easeAnimatableProperty` 是普通非 async
         函数（environment.js:196），`TypeError` 同步抛出、:341 的 `.catch()` 收不到 ⇒
         `collapse()` 在 `_expanded = false`（:998）和 `_cover.show()`（:1000）之前中止 ⇒
         组永久半折叠，之后每次点击都被 :1114 分支吞掉，托盘看起来是死的
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
Evidence L1 2026-10-08 `verify:headless` 14/14（新增 "merged source recognised"、
         "open() does not wipe the group"：调共享源 open() 后通知数不变）；L2 未验证
Cost     去掉覆盖即回到"点一张清整组"。它只作用于本扩展自建源，故删除它的代价仅限该场景
Commit   eb0a0fa

### D-009 · 2026-10-08 · taste · v7
Symptom  折叠组里点一张卡的 ×，原生 `messageList.js:1107` 会把 close 升级成"关整组"。
         原生一个源≈一张卡时看不见，合并后代价放大
Change   仅当"本扩展自建源 + 组处于折叠态"时，改为直接跑 close 的默认处理器 `on_close()`
         （GJS 按 `on_<signal>` 自动接线，已实测确认），只关被点的那张；原生源、展开态、
         单卡组一律走原生路径
Evidence L1 2026-10-08 `verify:ui-guard` 同一 harness 对新旧构建翻转：折叠组关一张，
         pre-fix 3 -> 0（整组），post-fix 3 -> 2（只关一张）；L2 未验证
Cost     taste 级：删掉它只退回"点 × 关整组"，不构成 bug。之所以仍做，是它与 D-008 同源
         （合并放大原生 per-source 行为），一起改才自洽
Commit   eb0a0fa
