#!/usr/bin/env node
// scripts/bench.mjs — the notification-grouper engine benchmark (node scripts/bench.mjs).
//
// The engine has been slimmed to the zero-config pure function computeGroup(): the hot path is only
// string normalisation + hash lookups, with no regex, no rule scanning, no file IO and no timers.
// This benchmark runs only the real app-only input distribution.

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

// Input mix: 40% desktop-entry, 40% named app_name, 20% generic/empty name (the former merges, the latter is isolated)
const inputs = Array.from({ length: 512 }, (_, i) => {
    if (i % 5 < 2)
        return { appName: 'electron-app', desktopEntry: `Tool${i % 16}.desktop` };
    if (i % 5 < 4)
        return { appName: `RealApp${i % 24}` };
    return { appName: i % 2 ? 'notify-send' : '' };
});

const N1 = 10_000, N2 = 100_000;
console.log(`== computeGroup app-only benchmark (node ${process.version})`);
bench(`×${N1}`, N1, (i) => computeGroup(inputs[i % 512]));

console.log(`== burst: ${N2} mixed notifications`);
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
console.log(`  ${N2} notifs / ${total.toFixed(1)} ms = ${(N2 / total * 1000 | 0).toLocaleString()} notifs/s (${((total * 1000) / N2).toFixed(3)} µs/op)`);
console.log(`  merged ${merged} / isolated ${isolated}`);
