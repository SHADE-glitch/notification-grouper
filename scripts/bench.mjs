#!/usr/bin/env node
// scripts/bench.mjs — notification-grouper 引擎基准（node scripts/bench.mjs）。
//
// 引擎已瘦身为零配置纯函数 computeGroup()：热路径只有字符串归一化 + 哈希查表，
// 无正则、无规则扫描、无文件 IO、无 timer。本基准只跑真实 app-only 输入分布。

import { computeGroup } from '../groupEngine.js';

const hr = () => process.hrtime.bigint();
const ms = (t0) => Number(hr() - t0) / 1e6;

function bench(label, iters, fn) {
    for (let i = 0; i < 1024; i++) fn(i); // warmup
    const t0 = hr();
    for (let i = 0; i < iters; i++) fn(i);
    const total = ms(t0);
    const perOp = (total * 1000) / iters;
    console.log(`  ${label.padEnd(28)} ${total.toFixed(1).padStart(9)} ms  ${perOp.toFixed(3).padStart(8)} µs/op`);
    return { total, perOp };
}

// 输入混合：40% desktop-entry、40% 具名 app_name、20% 通用名/空名（前者合并，后者隔离）
const inputs = Array.from({ length: 512 }, (_, i) => {
    if (i % 5 < 2)
        return { appName: 'electron-app', desktopEntry: `Tool${i % 16}.desktop` };
    if (i % 5 < 4)
        return { appName: `RealApp${i % 24}` };
    return { appName: i % 2 ? 'notify-send' : '' };
});

const N1 = 10_000, N2 = 100_000;
console.log(`== computeGroup app-only 基准（node ${process.version}）`);
bench(`×${N1}`, N1, (i) => computeGroup(inputs[i % 512]));

console.log(`== burst：${N2} 条混合通知`);
const t0 = hr();
let merged = 0, isolated = 0;
for (let i = 0; i < N2; i++) {
    const r = computeGroup(inputs[i % 512]);
    if (r.mergeable)
        merged++;
    else
        isolated++;
}
const total = ms(t0);
console.log(`  ${N2} 条 / ${total.toFixed(1)} ms = ${(N2 / total * 1000 | 0).toLocaleString()} 条/s（${((total * 1000) / N2).toFixed(3)} µs/op）`);
console.log(`  合并 ${merged} / 隔离 ${isolated}`);
