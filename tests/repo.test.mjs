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

    // HTTP status codes must agree across a pair: a code named on one side alone is a
    // fact that silently contradicts the other language. A code counts only in an HTTP
    // context (or quoted in backticks), so a plain number like `500 ms` never counts.
    const STATUS = "200|201|202|204|206|301|302|303|304|307|308|400|401|402|403|404|405|406|"
        + "407|408|409|410|411|412|413|414|415|416|417|418|421|422|423|424|425|426|428|"
        + "429|431|451|499|500|501|502|503|504|505|506|507|508|510|511";
    const STATUS_RE = new RegExp(
        "(?:HTTP|status|状态码|返回|returns?|responds?|replies?|answers?|gives?)[^\\n]{0,30}?\\b(" + STATUS + ")\\b"
        + "|`(" + STATUS + ")`"
        + "|`(" + STATUS + ")\\s*\\+", "gi");

    it("the bilingual pairs name the same HTTP status codes", () => {
        const codes = (text) => {
            const out = new Set();
            for (const m of text.matchAll(STATUS_RE))
                out.add(m[1] || m[2] || m[3]);
            return [...out].sort();
        };
        for (const [en, zh] of pairs) {
            const ce = codes(read(en)), cz = codes(read(zh));
            assert.deepEqual(ce, cz,
                `${en} names [${ce}] but ${zh} names [${cz}] — the two languages disagree on a status code`);
        }
    });

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

    it("metadata.json keeps the extension enabled on the lock screen", () => {
        // GNOME Shell disables any extension whose session-modes do not include the
        // current mode (extensionSystem.js:48, :165-180; the key defaults to ["user"]
        // at :394), and unlock-dialog has no parentMode to fall back on. disable()
        // destroys every merged source by design, so without "unlock-dialog" every
        // grouped notification dies the moment the screen locks — while native app
        // stacks survive, which makes it look like a grouping bug. Measured
        // 2026-10-17: "disabled, restored patches" at 23:05:09, "enabled" at 07:44:19,
        // merged stacks gone and native stacks intact.
        // The key replaces GNOME's default, so both modes must be listed: dropping
        // "user" would leave the extension running only on the lock screen.
        const modes = JSON.parse(read("metadata.json"))["session-modes"] ?? [];
        assert.ok(modes.includes("user"),
            `metadata.json session-modes is [${modes}] — without "user" the extension never runs in the normal session`);
        assert.ok(modes.includes("unlock-dialog"),
            `metadata.json session-modes is [${modes}] — without "unlock-dialog" GNOME disables the extension when the screen locks and every merged stack is destroyed`);
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

// ── dimension-A layout guard ───────────────────────────────────────────────────
// CONVENTIONS.md and STANDARD.md live in a private repository that this
// repository's CI cannot read, so the dimension-A rules they carry are restated
// here as executable assertions. Nothing is fetched; only this tree is inspected,
// so the guard belongs to the offline CI layer and runs unchanged on a bare clone.
//
// The reports/ half of the runtime rule is already enforced by
// "reports/ stays untracked" in the block above; this one adds the root layer, the
// dimension pointer, and the rest of the §7 ignore list.
//
// Every assertion says what is missing AND where it belongs, so a red run tells the
// next session how to fix itself instead of only that something broke.
describe("dimension-A layout invariants hold", () => {
    const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

    // STANDARD.md §1, dimension A: the finalized layer. A plugin's manifest is
    // package.json, and exactly one manifest may exist.
    const ROOT_FILES = [
        "AGENTS.md",
        "README.md",
        "README.zh-CN.md",
        "CHANGELOG.md",
        "MAINTENANCE.md",
        "MAINTENANCE.zh-CN.md",
        "LICENSE",
        ".gitignore",
        "package.json",
    ];
    const ROOT_DIRS = ["docs", ".github/workflows"];

    // §7: the runtime ignore list, the minimum every repository carries.
    const IGNORE_ENTRIES = [
        ".venv/",
        "venv/",
        "__pycache__/",
        "*.db",
        "*.db-wal",
        "*.db-shm",
        ".pytest_cache/",
    ];

    // §4: once aligned, AGENTS.md states its dimension in one line and points at
    // the right page. These are the section headings of the standard —
    // CONVENTIONS.md, STANDARD.md and dimensions/a.md — a match means AGENTS.md
    // restated the standard's body instead of referencing it, which the layout
    // audit scores as a missing guard.
    const STANDARD_HEADINGS = [
        "Repositories governed by this standard",
        "Root files (the finalized layer)",
        "Language policy",
        "Process-draft location",
        "CHANGELOG format",
        "Test entry commands",
        "Runtime ignore list",
        "Conflict rule",
        "Remotes and pushing",
        "Audit ruleset (anchor)",
        "The three dimensions",
        "The shared common core",
        "Where each dimension's detail lives",
        "Unify the common core",
        "Where a repository points",
    ];

    it("the finalized root-file layer is present and in the right place", () => {
        const missingFiles = ROOT_FILES.filter((rel) => !fs.existsSync(path.join(REPO, rel)));
        const missingDirs = ROOT_DIRS.filter((rel) => {
            const p = path.join(REPO, rel);
            return !fs.existsSync(p) || !fs.statSync(p).isDirectory();
        });
        const detail = [
            ...missingFiles.map((f) => `  - ${f}: create this file at the repository root`),
            ...missingDirs.map((d) => `  - ${d}/: create this directory at the repository root`),
        ].join("\n");
        assert.equal(detail, "",
            `the dimension-A root layer is incomplete; the repository root is the only correct location:\n${detail}`);

        const manifests = ["package.json", "pyproject.toml"].filter((m) => fs.existsSync(path.join(REPO, m)));
        assert.deepEqual(manifests, ["package.json"],
            `dimension A of a GNOME Shell extension carries exactly one manifest and it is package.json, but this repository has ${manifests.join(" + ") || "none"}`);

        assert.ok(!fs.existsSync(path.join(REPO, "AGENTS.zh-CN.md")),
            "AGENTS.zh-CN.md is the bilingual application shape, not this one — AGENTS.md is English-only here because every AGENTS.md outside the language whitelist is English");
    });

    it("AGENTS.md names its dimension in one line instead of restating the standard", () => {
        const agents = read("AGENTS.md");
        assert.match(agents, /^\s*>\s*\*\*Dimension\.\*\*/m,
            "AGENTS.md opens with no one-line dimension pointer. Add a blockquote line naming this repository as dimension A of the machine-wide CONVENTIONS.md, immediately above the existing shared-standard blockquote — name it, do not paste the rules");
        assert.match(agents, /CONVENTIONS\.md/,
            "the dimension pointer must name CONVENTIONS.md (outside this repository), which is where the dimension and its requirements are defined");
        for (const heading of STANDARD_HEADINGS) {
            assert.ok(!agents.includes(heading),
                `AGENTS.md restates the shared standard: "${heading}" is a section heading of CONVENTIONS.md or STANDARD.md. Keep the rule in the standard and leave a pointer here, so the two copies cannot drift`);
        }
    });

    it("the §7 runtime ignore list holds and no runtime state is tracked", () => {
        const rules = read(".gitignore")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));
        const missing = IGNORE_ENTRIES.filter((entry) => !rules.includes(entry));
        assert.deepEqual(missing, [],
            `.gitignore lost ${missing.length} machine-wide runtime entr${missing.length === 1 ? "y" : "ies"} (${missing.join(", ")}). Add each as its own uncommented line — a stray virtualenv or database beside the extension would otherwise become committable`);

        const trackedRuntime = git("ls-files", "-z").split("\0").filter(Boolean).filter((f) =>
            /(^|\/)(__pycache__|\.pytest_cache|\.venv|venv)\//.test(f) ||
            /\.db(-wal|-shm|-journal)?$/.test(f) || /\.shell-extension\.zip$/.test(f));
        assert.deepEqual(trackedRuntime, [],
            "runtime state is tracked; untrack it with `git rm --cached` and let the ignore rules take over, otherwise a database, a cache directory or the packed zip reaches the public remote");
    });
});
