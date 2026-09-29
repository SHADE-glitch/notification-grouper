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
// 只有 app_name 归一化后为空（发送方未声明任何身份）才 mergeable=false，
// 交给原生 per-pid Source 隔离。默认恒 stack，上限由原生 addNotification 强制
// （messageTray.js MAX_NOTIFICATIONS_PER_SOURCE = 10），不丢消息。

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
 * @returns {{groupKey: string|null, mergeable: boolean}}
 *   mergeable=true 时 groupKey 形如 `app:<归一化标识>`，可复用同一共享 Source；
 *   mergeable=false 时 groupKey 为 null，扩展层走原生 per-pid 隔离。
 */
export function computeGroup({ appName, desktopEntry, appId } = {}) {
    const entry = normalizeName(desktopEntry);
    if (entry)
        return { groupKey: `app:${entry}`, mergeable: true };

    const id = normalizeName(appId);
    if (id)
        return { groupKey: `app:${id}`, mergeable: true };

    const name = normalizeName(appName);
    if (name)
        return { groupKey: `app:${name}`, mergeable: true };

    return { groupKey: null, mergeable: false };
}

// 需要挂接的补丁点（缺任一 -> 扩展自降级为完全惰性，只记一条警告）。
export const REQUIRED_PATCHES = [
    'NotifyAsync',
    '_getSourceForPidAndName',
];

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
