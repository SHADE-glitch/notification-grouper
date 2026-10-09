// groupEngine.js — notification-grouper 纯函数（零配置，只按发出应用分组）.
//
// 约束：
// - 无 gi / 无 Shell 依赖，GJS (ESM) 与 Node 共用同一文件。
// - 热路径零正则、零文件 IO、零 timer；只有字符串归一化与哈希查表。
// - 引擎内没有任何具体应用名分支：通用名（notify-send / node-notifier）不是
//   特例，只是发送方自己声明的身份，照样作为分组键。
//
// 分组键优先级：desktopEntry > appId > 归一化 app_name。
// 发送方声明了什么就按什么分：同一个名字跨 pid 合并到一个共享 Source。
// mergeable=false 的三种情形，全部交回原生 per-pid 隔离：app_name 归一化后为空
// （发送方未声明任何身份）、grouping-enabled=false、命中 isolate-apps 例外表。
//
// 条数上限：原生 messageTray.js:25 的 MAX_NOTIFICATIONS_PER_SOURCE = 10 会**丢弃**最旧的一条
// （:577-580 同步 while 循环，reason=EXPIRED）。合并把"一个源"从"一个进程"变成"一个应用"，
// 于是这个上限的作用域被放大——同一应用发到第 11 条时，最早那条就没了。本扩展不额外丢任何
// 通知，但也不阻止原生丢；设置项 max-per-source 只能把 10 往小调（放大要复制原生
// addNotification，多一个脆弱补丁点，不值）。

/**
 * 归一化应用标识：去首尾空白、转小写、去 .desktop 后缀。
 * 不用正则（热路径约定），.desktop 为固定长度后缀直接切片。
 * @param {string} s
 * @returns {string}
 */
export function normalizeName(s) {
    const t = String(s ?? '').trim().toLowerCase();
    return t.endsWith('.desktop') ? t.slice(0, -'.desktop'.length) : t;
}

/**
 * 计算分组。
 * @param {object} [input]
 * @param {string} [input.appName]      FDO Notify 第一个参数
 * @param {string} [input.desktopEntry] hints['desktop-entry']（unpacked 后）
 * @param {string} [input.appId]        预留：portal/Gtk 路径的应用 id（FDO 路径一般无）
 * @param {boolean} [input.enabled]     设置项 grouping-enabled；false 时一律走原生
 * @param {Set<string>|null} [input.isolated] 已归一化的例外应用名集合（见 normalizeIsolate）
 * @returns {{groupKey: string|null, mergeable: boolean}}
 *   mergeable=true 时 groupKey 形如 `app:<归一化标识>`，可复用同一共享 Source；
 *   mergeable=false 时 groupKey 为 null，扩展层走原生 per-pid 隔离。
 *   例外应用与关闭分组都归到 mergeable=false：语义相同（"这条不合并"），
 *   原生 fallthrough 一条路就够，不在扩展层再添分支。
 */
export function computeGroup({ appName, desktopEntry, appId, enabled = true, isolated = null } = {}) {
    if (!enabled)
        return { groupKey: null, mergeable: false };

    const entry = normalizeName(desktopEntry);
    if (entry)
        return _group(entry, isolated);

    const id = normalizeName(appId);
    if (id)
        return _group(id, isolated);

    const name = normalizeName(appName);
    if (name)
        return _group(name, isolated);

    return { groupKey: null, mergeable: false };
}

function _group(identity, isolated) {
    if (isolated && isolated.has(identity))
        return { groupKey: null, mergeable: false };
    return { groupKey: `app:${identity}`, mergeable: true };
}

/**
 * 把用户填的例外列表归一化成查找集合（设置里存的是原始字符串，比较发生在热路径，
 * 所以归一化只在读取时做一次）。空项丢弃，重复项合并，大小写/空白/.desktop 不敏感。
 * @param {string[]} list
 * @returns {Set<string>}
 */
export function normalizeIsolate(list) {
    const out = new Set();
    for (const raw of list ?? []) {
        const n = normalizeName(raw);
        if (n)
            out.add(n);
    }
    return out;
}

// 需要挂接的补丁点（缺任一 -> 扩展自降级为完全惰性，只记一条警告）。
export const REQUIRED_PATCHES = [
    'NotifyAsync',
    '_getSourceForPidAndName',
];

// UI 兜底点：修的是 GNOME 原生 messageList.js 的缺陷，与分组机制无关，
// 因此与 REQUIRED_PATCHES 相互独立 —— 取不到就只丢兜底，绝不拖累分组。
export const REQUIRED_UI_GUARDS = [
    'Message.unexpand',
    'NotificationMessageGroup.collapse',
    'NotificationMessage.close',
];

/**
 * UI 兜底点自检（纯函数，供 _attachUiGuards 自降级与单测共用）。
 * @param {object} [info]
 * @param {boolean} [info.moduleLoaded] messageList.js 是否 import 成功
 * @param {boolean} [info.hasMessage]
 * @param {boolean} [info.hasGroup]
 * @param {boolean} [info.hasNotifMessage]
 * @param {boolean} [info.hasUnexpand]
 * @param {boolean} [info.hasCollapse]
 * @param {boolean} [info.hasNotifClose]
 * @param {string} [info.detail] 诊断用
 * @returns {{apply: boolean, warnings: string[], guards: string[]}}
 */
export function checkUiGuardPoints(info = {}) {
    const warnings = [];
    if (!info.moduleLoaded) {
        warnings.push(`messageList module unavailable [${info.detail ?? 'unknown'}]`);
    } else {
        if (!info.hasMessage)
            warnings.push('Message class not exported');
        if (!info.hasGroup)
            warnings.push('NotificationMessageGroup class not exported');
        if (!info.hasNotifMessage)
            warnings.push('NotificationMessage class not exported');
        if (!info.hasUnexpand)
            warnings.push('Message.prototype.unexpand missing');
        if (!info.hasCollapse)
            warnings.push('NotificationMessageGroup.prototype.collapse missing');
        if (!info.hasNotifClose)
            warnings.push('NotificationMessage.prototype.close missing');
    }
    if (warnings.length > 0)
        return { apply: false, warnings, guards: [] };
    return { apply: true, warnings, guards: [...REQUIRED_UI_GUARDS] };
}

/**
 * 挂接点自检（纯函数，供扩展 enable 自降级与单测共用）。
 * @param {object} [info]
 * @param {boolean} [info.hasFdo]
 * @param {string} [info.fdoKeys] 诊断用：实际看到的属性名
 * @param {boolean} [info.hasNotifyAsync]
 * @param {boolean} [info.hasGetSource]
 * @returns {{attach: boolean, warnings: string[], patches: string[]}}
 */
export function checkAttachPoints(info = {}) {
    const warnings = [];
    if (!info.hasFdo) {
        warnings.push(
            `_fdoNotificationDaemon unreachable [${info.fdoKeys ?? 'unknown'}]`);
    } else {
        if (!info.hasNotifyAsync)
            warnings.push('NotifyAsync missing on FDO instance');
        if (!info.hasGetSource)
            warnings.push('_getSourceForPidAndName missing on FDO instance');
    }
    if (warnings.length > 0)
        return { attach: false, warnings, patches: [] };
    return { attach: true, warnings, patches: [...REQUIRED_PATCHES] };
}
