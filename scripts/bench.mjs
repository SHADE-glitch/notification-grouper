#!/usr/bin/env node
// scripts/bench.mjs — notification-grouper 引擎基准（node scripts/bench.mjs）。
//
// 对比口径（同一进程、同一引擎、同一输入，唯一变量是规则是否预编译）：
// - legacy   : 规则不带预编译 re，引擎每通知每规则 new RegExp（优化前行为）
// - compiled : 同一规则表经 compileRules() 预编译（优化后行为，加载时一次性成本）
//
// 另含 burst 模拟：10 万条混合来源通知连续过引擎，给出吞吐。
// 日志聚合 / TTL 单 timer 的收益在主循环侧（journal I/O 与 GSource 数量），
// 不在纯引擎范围，见交付报告。

import { computeGroup, compileRules } from '../groupEngine.js';

const hr = () => process.hrtime.bigint();
const ms = (t0) => Number(hr() - t0) / 1e6;

function bench(label, iters, fn) {
    for (let i = 0; i < 1024; i++) fn(i); // warmup
    const t0 = hr();
    for (let i = 0; i < iters; i++) fn(i);
    const total = ms(t0);
    const perOp = (total * 1000) / iters;
    console.log(`  ${label.padEnd(46)} ${total.toFixed(1).padStart(9)} ms  ${perOp.toFixed(3).padStart(8)} µs/op`);
    return { total, perOp };
}

// 规则表：5 / 20 条标题规则（小/中配置）
const mkRaw = (k) => ({
    titlePrefixRules: Array.from({ length: k }, (_, i) => ({
        pattern: `^App${i}:`, group: `app${i}`,
    })),
    groups: {},
});

// 输入混合：70% 匿名（走规则扫描/启发式）、20% 具名 app、10% 兜底
const inputs = Array.from({ length: 512 }, (_, i) => {
    if (i % 10 < 7)
        return { appName: 'notify-send', title: `SomeTool${i % 64}: event ${i}`, senderPid: 1000 + i };
    if (i % 10 < 9)
        return { appName: `RealApp${i}`, title: 'hello', senderPid: 2000 + i };
    return { appName: 'notify-send', title: 'random words no prefix', senderPid: 3000 + i };
});

const N1 = 10_000, N2 = 100_000;
console.log(`== computeGroup 基准（node ${process.version}）`);
for (const k of [0, 5, 20]) {
    const raw = mkRaw(k);
    const compiled = compileRules(raw).rules;
    console.log(`-- rules=${k}`);
    const a = bench(`legacy   ×${N1}`, N1, (i) => computeGroup(inputs[i % 512], raw));
    const b = bench(`compiled ×${N1}`, N1, (i) => computeGroup(inputs[i % 512], compiled));
    console.log(`  => 省 ${((1 - b.perOp / a.perOp) * 100).toFixed(0)}%`);
}

console.log(`== burst 模拟：${N2} 条混合通知（rules=5, compiled）`);
const compiled5 = compileRules(mkRaw(5)).rules;
const t0 = hr();
let groups = 0;
for (let i = 0; i < N2; i++) {
    computeGroup(inputs[i % 512], compiled5);
    groups++;
}
const total = ms(t0);
console.log(`  ${groups} 条 / ${total.toFixed(1)} ms = ${(N2 / total * 1000 | 0).toLocaleString()} 条/s（${((total * 1000) / N2).toFixed(3)} µs/op）`);
console.log('  参考：100 条/s 的真实突发仅占用主线程引擎时间 ' + ((100 * total * 1000) / N2).toFixed(0) + ' µs/s');
