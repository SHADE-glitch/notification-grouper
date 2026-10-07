#!/usr/bin/env node
/**
 * check-log.mjs — the recording-coverage check. No dependencies, no build step;
 * `node tests/check-log.mjs` is the real gate and must keep working without npm.
 *
 * Five checks, all bounded by the window declared in CHANGELOG.md:
 *   1. the coverage anchor resolves
 *   2. D-### ids are unique, strictly increasing, gapless, never reused
 *   3. every commit that touched a code path inside the window is cited by an entry
 *   4. every D-### mentioned in any tracked .md resolves to a real entry
 *   5. every entry carries all five fields and a kind from the allowed set
 *
 * Aggregate counts are printed here and are never hand-copied into the documents
 * they count.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = 'CHANGELOG.md';

/** Code paths whose changes must be recorded. Declared, never inferred. */
const CODE_PATHS = ['extension.js', 'groupEngine.js'];
const KINDS = ['fix', 'taste', 'guard', 'revert'];
const FIELDS = ['Symptom', 'Change', 'Evidence', 'Cost', 'Commit'];

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const problems = [];
const fail = (msg) => problems.push(msg);

/** Short or long hash -> full sha, or null when it is not a commit here. */
function resolveSha(ref) {
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    return null;
  }
}

let changelog;
try {
  changelog = readFileSync(path.join(ROOT, CHANGELOG), 'utf8');
} catch {
  console.error(`[check:log] FAIL: ${CHANGELOG} not found in ${ROOT}`);
  process.exit(1);
}

/* ---- the window, declared in the file header ------------------------------ */
const coverage = changelog.match(/^Coverage:\s*([0-9a-zA-Z^~_/-]+)\.\.\*?HEAD\s*$/m);
if (!coverage) {
  console.error(`[check:log] FAIL: no "Coverage: <anchor>..HEAD" line in ${CHANGELOG}`);
  process.exit(1);
}
const anchor = coverage[1];
const anchorSha = resolveSha(anchor);
if (!anchorSha) fail(`1. coverage anchor does not resolve: ${anchor}`);

/* ---- the entries ---------------------------------------------------------- */
const entryRe = /^### (D-\d+) · (\d{4}-\d{2}-\d{2}) · ([a-z]+)(?: · (.*))?$/gm;
const entries = [...changelog.matchAll(entryRe)];
const ids = entries.map((m) => m[1]);

for (const m of entries) {
  if (!KINDS.includes(m[3])) fail(`5. ${m[1]}: kind "${m[3]}" is not one of ${KINDS.join('/')}`);
  const body = changelog.slice(changelog.indexOf(m[0]) + m[0].length).split(/^### /m)[0];
  for (const field of FIELDS) {
    if (!new RegExp(`^${field}\\s`, 'm').test(body)) fail(`5. ${m[1]}: missing field "${field}"`);
  }
}

/* ---- 2. id discipline ----------------------------------------------------- */
const numbers = ids.map((id) => Number(id.slice(2)));
const seen = new Map();
numbers.forEach((n, i) => {
  const id = ids[i];
  if (seen.has(n)) fail(`2. id ${id} reuses number ${n} (already used by ${seen.get(n)})`);
  else seen.set(n, id);
});
for (let i = 1; i < numbers.length; i++) {
  if (numbers[i] <= numbers[i - 1]) fail(`2. ids must increase: ${ids[i]} follows ${ids[i - 1]}`);
}
const top = Math.max(0, ...numbers);
for (let n = 1; n <= top; n++) {
  if (!seen.has(n)) fail(`2. id gap: D-${String(n).padStart(3, '0')} is missing (numbers are never reused, so a gap means an entry was deleted)`);
}

/* ---- 3. coverage of code-touching commits --------------------------------- */
const recorded = new Set();
for (const m of changelog.matchAll(/^Commit\s+(.*)$/gm)) {
  for (const ref of m[1].split(/[\s,]+/).filter(Boolean)) {
    const sha = resolveSha(ref);
    if (!sha) fail(`3. ${CHANGELOG} cites a commit that does not exist: ${ref}`);
    else recorded.add(sha);
  }
}
const uncovered = [];
if (anchorSha) {
  const out = git(['log', '--format=%H%x00%s', `${anchorSha}..HEAD`, '--name-only', '--', ...CODE_PATHS]);
  let sha = null;
  let subject = '';
  let touches = false;
  const flush = () => {
    if (sha && touches && !recorded.has(sha)) uncovered.push(`${sha.slice(0, 7)} ${subject}`);
    touches = false;
  };
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const nul = line.indexOf('\u0000');
    if (nul > 0 && /^[0-9a-f]{40}$/.test(line.slice(0, nul))) {
      flush();
      sha = line.slice(0, nul);
      subject = line.slice(nul + 1);
    } else if (CODE_PATHS.includes(line.trim())) {
      touches = true;
    }
  }
  flush();
}
if (uncovered.length) {
  fail(`3. ${uncovered.length} commit(s) touched ${CODE_PATHS.join(', ')} but no entry cites them:`);
  for (const u of uncovered) console.error(`      ${u}`);
}

/* ---- 4. references from other documents ----------------------------------- */
const tracked = git(['ls-files', '-z', '*.md']).split('\0').filter(Boolean);
for (const file of tracked) {
  if (file === CHANGELOG) continue;
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of text.matchAll(/\bD-(\d{3,})\b/g)) {
    if (!seen.has(Number(m[1]))) fail(`4. ${file} references D-${m[1]}, which has no entry`);
  }
}

/* ---- report --------------------------------------------------------------- */
const codeCommits = git(['rev-list', '--count', `${anchorSha}..HEAD`, '--', ...CODE_PATHS]);
console.log(`[check:log] window ${anchor}..HEAD, code paths ${CODE_PATHS.join(' ')}: ${codeCommits} commit(s) touched them`);
console.log(`[check:log] ${entries.length} entr(ies), ${recorded.size} distinct commit(s) cited`);
if (problems.length) {
  console.error(`[check:log] FAIL (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('[check:log] PASS');
