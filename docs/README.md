# docs/

This is the repository's documentation root.

- `reports/` holds this extension's **per-phase maintenance evidence** — `PROFILE.md`, `AUDIT.md`,
  `PLAN.md`, `VERIFY.md`, `STATE.md`, `REVIEW-PACK.md` and draft notes. Those files quote raw
  journal lines, application names and resolved temp paths, so they are **local-only**: the
  unanchored `reports/` rule ignores the directory, and nothing under it may ever be tracked.
- This `README.md` is tracked so the directory itself is present in a clean clone. The dimension-A
  layout guard (`tests/repo.test.mjs`) requires `docs/` at the repository root, and git cannot carry
  an empty directory.

The rules live in the machine-wide standard; `AGENTS.md` carries the pointer to it.
