// SPDX-License-Identifier: GPL-2.0-or-later
// © SHADE-glitch — repository-level guards for notification-grouper@local.
//
// These tests assert nothing about runtime behaviour. They guard *invariants of
// the repository itself* — the ones where a silent violation costs far more than
// a failing test. The README pair drifting apart is the one that matters here:
// a reader of one language silently loses a section the other still has.
//
//   npm test          (desktop-free: no gjs, no GNOME, no network)
//
// Each describe names the rule it protects, and every assertion message says
// what a failure MEANS, so a red run is self-explanatory. Replicated from
// macos-dock@local's test/repo.test.js "documentation conventions hold" block so
// every fork in this workspace enforces the same rule.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_PATCHES, REQUIRED_UI_GUARDS } from "../groupEngine.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every file in the working tree that git would be willing to commit, skipping VCS
 * and install noise. This is a directory walk rather than `git ls-files` on purpose:
 * the guards must also see a brand-new harness script one second before it is
 * committed. Ignored paths are then subtracted with git's own rule, because
 * `reports/` (phase evidence: journal lines, real application names) is deliberately
 * invisible to the repository but plainly visible to readdirSync.
 */
function listFiles() {
    const out = [];
    const skip = new Set([".git", "node_modules", ".gitignore", "__pycache__"]);
    const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
            if (skip.has(e.name))
                continue;
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory())
                walk(r);
            else if (e.isFile())
                out.push(r);
        }
    };
    walk("");
    return out.sort();
}

function ignoredFiles() {
    // One git call, not one per file. If git is unavailable this throws and the
    // suite fails loudly — a guard that silently skips is a guard that never fired.
    return new Set(execFileSync(
        "git", ["ls-files", "--others", "--ignored", "--exclude-standard"],
        { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean));
}

const IGNORED = ignoredFiles();
const FILES = listFiles().filter(f => !IGNORED.has(f));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

describe("documentation conventions hold", () => {
    // House convention across every fork in this workspace: user-facing docs are
    // a two-file bilingual pair with mirrored section order, English first.
    // Heading LINE numbers are reported, not asserted — they cannot survive
    // prose edits. Section COUNT and order can, and that is the enforceable
    // version of the same rule.
    const pairs = FILES
        .filter(f => f.endsWith(".md") && path.dirname(f) === ".")
        .filter(f => f.endsWith(".zh-CN.md"))
        .map(zh => [zh.replace(/\.zh-CN\.md$/, ".md"), zh]);

    it("every Chinese doc has an English twin with the same section count", () => {
        assert.ok(pairs.length >= 1, "no bilingual pairs found");
        for (const [en, zh] of pairs) {
            assert.ok(FILES.includes(en), `${zh} has no English twin (${en})`);
            const h2 = (f) => (read(f).match(/^## /gm) || []).length;
            assert.equal(h2(en), h2(zh),
                `${en} has ${h2(en)} sections but ${zh} has ${h2(zh)} — keep the pair in step`);
            for (const f of [en, zh])
                assert.match(read(f), /^<p align="right"><a href=/,
                    `${f} must open with the language switcher so the pair stays navigable`);
        }
    });

    it("no tracked markdown uses task checkboxes", () => {
        // Every doc in this repo uses bullets, tables or prose. Checkboxes in a
        // committed doc read as unfinished work and never get cleaned up.
        for (const f of FILES.filter(x => x.endsWith(".md")))
            assert.ok(!/^\s*- \[[ xX]\]/m.test(read(f)), `${f} contains a task checkbox`);
    });
});

describe("shipped code keeps the promises its comments make", () => {
    // Each guard below checks a claim that was, until now, only a comment in the
    // source. A comment that rots is worse than no comment: the next reader trusts
    // it. None of these can be caught at runtime, which is exactly why they live here.
    const SHIPPED = FILES.filter(f => /^[^/]+\.js$/.test(f));

    it("no timer or repeating source in the shipped code", () => {
        // The cost model is "structurally zero idle cost — the extension only runs
        // when a notification arrives". One timeout_add would break that and every
        // existing runtime assertion would still pass.
        const re = /timeout_add|idle_add|TickScheduler|setTimeout|setInterval/;
        for (const f of SHIPPED)
            assert.ok(!re.test(read(f)),
                `${f} arms a timer or repeating source; the zero-idle-cost claim is now false`);
        assert.ok(SHIPPED.length >= 1, "no shipped sources found to check");
    });

    it("groupEngine.js stays free of gi:// and resource:// so Node can load it", () => {
        // It is the only module this repo can unit-test without a shell. Adding
        // either scheme here silently deletes L0 coverage rather than failing.
        const src = read("groupEngine.js");
        for (const scheme of ["gi://", "resource://"])
            assert.ok(!src.includes(scheme),
                `groupEngine.js now references ${scheme} — Node cannot import it, so npm test proves nothing`);
    });

    it("every declared patch point is still named in the module that owns it", () => {
        // checkAttachPoints() and checkUiGuardPoints() are tested against hand-written
        // fake objects, so a rename left the declared lists green while the extension
        // degraded to inert in the field. The names must exist in the real code — and
        // in the module that is supposed to own them, which is what pins the split:
        // grouping patches in extension.js, upstream workarounds in uiWorkarounds.js.
        const HOME = {
            daemon: "extension.js",
            guard: "uiWorkarounds.js",
        };
        const ext = read(HOME.daemon);
        const uiw = read(HOME.guard);
        for (const p of REQUIRED_PATCHES)
            assert.ok(ext.includes(`fdo.${p}`),
                `${p} is declared required, but ${HOME.daemon} no longer mentions fdo.${p}`);
        for (const g of REQUIRED_UI_GUARDS) {
            const method = g.split(".")[1];
            assert.ok(uiw.includes(`prototype.${method}`),
                `${g} is declared required, but ${HOME.guard} no longer mentions prototype.${method}`);
        }
        // The guards are a workaround for an upstream defect: they must stay together in
        // one deletable unit. If one crept back into extension.js, the "rm the file"
        // deletion step would silently leave a patch behind.
        for (const method of REQUIRED_UI_GUARDS.map(g => `prototype.${g.split(".")[1]}`))
            assert.ok(!ext.includes(method),
                `${HOME.daemon} patches a prototype (${method}) — the workaround unit leaked`);
    });

    it("no Gtk/Gdk import in the shell process (prefs.js is the only place allowed)", () => {
        // extension.js / uiWorkarounds.js run inside gnome-shell, which has no GTK
        // display; importing Gtk there is a crash at load, not a style issue.
        // prefs.js runs in its own GTK4 process and MUST import Adw/Gtk — so the guard
        // names the shell-side files instead of sweeping the whole tree.
        const SHELL_SIDE = ["extension.js", "uiWorkarounds.js", "groupEngine.js"];
        for (const f of SHELL_SIDE) {
            const src = read(f);
            for (const ns of ["gi://Gtk", "gi://Gdk", "gi://Adw"])
                assert.ok(!src.includes(ns),
                    `${f} imports ${ns} — that is the prefs process's toolkit, and it breaks shell load`);
        }
        // and the prefs file really does have them, otherwise this pair of rules is
        // vacuous (a renamed prefs.js would silent the whole thing)
        const prefs = read("prefs.js");
        assert.match(prefs, /gi:\/\/Adw/, "prefs.js must import Adw; the split above assumes it");
    });

    it("the pack manifest covers every module the shipped code imports", () => {
        // `gnome-extensions pack` on GNOME 50 ships a fixed filename whitelist and
        // exits 0 whether or not the rest made it in. Every module this repo split out
        // of extension.js therefore has to be declared in tests/pack.sh, or the
        // installable zip contains an extension that cannot even load — measured: the
        // undeclared bundle ran 2/41 in tests/headless-verify.sh. The packer also ships
        // schemas/<id>.gschema.xml but never gschemas.compiled, which is the file the
        // runtime actually opens (new_from_directory() throws without it).
        const pack = read("tests/pack.sh");
        const declared = (name) => {
            const m = pack.match(new RegExp(`^${name}="([^"]*)"$`, "m"));
            assert.ok(m, `tests/pack.sh must declare ${name}=...`);
            return new Set(m[1].split(/\s+/).filter(Boolean));
        };
        const extras = declared("EXTRA_SOURCES");
        const extraFiles = declared("EXTRA_FILES");
        const AUTO = new Set(["extension.js", "prefs.js", "metadata.json",
                              "stylesheet.css", "stylesheet-dark.css", "stylesheet-light.css"]);

        const imported = new Set();
        for (const f of SHIPPED)
            for (const m of read(f).matchAll(/from\s+['"]\.\/([^'"]+\.js)['"]/g))
                imported.add(m[1]);
        // anti-vacuity: if the split is ever collapsed back into one file, this check
        // has no subject and must say so rather than pass silently
        assert.ok(imported.size >= 2,
            `only ${imported.size} local module(s) imported by shipped code — the import scan lost its target set`);
        for (const mod of imported)
            assert.ok(AUTO.has(mod) || extras.has(mod),
                `${mod} is imported by shipped code but declared nowhere in tests/pack.sh — the bundle would load inert`);

        assert.ok(extraFiles.has("schemas/gschemas.compiled"),
            "schemas/gschemas.compiled must be an EXTRA_FILE: the packer only ships the .xml, " +
            "so the bundle would no longer equal the source tree that git clone installs");
    });

    it("reports/ stays untracked — phase evidence must not be pushed", () => {
        // The repository is public while reports/ quotes journal lines and real
        // application names. .gitignore carries the rule; git proves it holds.
        assert.match(read(".gitignore"), /^reports\/?$/m,
            ".gitignore lost its reports/ entry — local evidence would become publishable");
        const tracked = execFileSync("git", ["ls-files", "--", "reports"],
            { cwd: REPO, encoding: "utf8" }).trim();
        assert.equal(tracked, "",
            `these files under reports/ are tracked and would be pushed: ${tracked}`);
    });

    it("records carry no real application name", () => {
        // AGENTS.md: CHANGELOG Symptom lines and fixture provenance must not name a
        // desktop application — the shipped engine contains no app name at all, and a
        // public record that does names the author's toolchain. The fixtures used to
        // break this (a captured title read "<an IDE> 任务完成"), and nothing checked it
        // because the existing doc scanner only walks *.md. So this sweep covers the
        // JSON fixtures too.
        // The list is this checker's own vocabulary: names that were actually captured
        // here. It is the single place a name may appear, hence the self-exemption.
        const NAMES = ["codebuddy", "codenotify", "code-notify", "trae", "opencode"];
        const RECORDS = FILES.filter(f =>
            f.endsWith(".md") || f.startsWith("tests/fixtures/") ||
            /^tests\/[^/]+\.(mjs|js)$/.test(f));
        for (const f of RECORDS) {
            if (f === "tests/repo.test.mjs")
                continue;
            const low = read(f).toLowerCase();
            for (const n of NAMES)
                assert.ok(!low.includes(n),
                    `${f} names a real application ("${n}"); use a generic placeholder and keep the evidence in the pid/hints`);
        }
        // the guard must have something to guard: an empty RECORDS set would be a fake green
        assert.ok(RECORDS.length >= 4,
            `only ${RECORDS.length} record files found — the sweep lost its target set`);
    });
});
