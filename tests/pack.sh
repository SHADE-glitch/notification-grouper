#!/bin/bash
# tests/pack.sh — produce an installable zip and prove its contents are complete.
#
# Why a wrapper is needed at all (all three measured on GNOME 50 tooling):
#
#   1. `gnome-extensions pack` auto-includes only a fixed set of filenames
#      (metadata.json, extension.js, prefs.js, stylesheet*.css). This extension's
#      split-out modules are **silently dropped** — exit code 0, broken bundle.
#      Verified: the naive bundle ran 2/41 in tests/headless-verify.sh, because
#      `extension.js` cannot even import its engine.
#   2. For settings it ships `schemas/<id>.gschema.xml` (driven by metadata.json's
#      `settings-schema`) but **never** `schemas/gschemas.compiled`, which is the file
#      `Gio.SettingsSchemaSource.new_from_directory()` actually opens: measured with gjs,
#      a `schemas/` holding only the .xml throws "Failed to open file …/gschemas.compiled".
#      A directory-installed extension gets that file generated for it locally — every
#      third-party extension on this box has a compiled newer than its .xml — so the
#      reason to ship it here is that the **bundle must equal the source tree**, which is
#      what `git clone` installs and what already works. Not because a zip without it is
#      guaranteed to break: the install route that would compile it is not this CLI.
#   3. `--extra-source=schemas/gschemas.compiled` does add the file, but at the zip
#      **root**, not under `schemas/` — a wrong path is the same as absent.
#      And `--schema=schemas` just fails with "Can't recursively copy directory".
#
# Do not "verify" any of this with `gnome-extensions install <zip>`: measured on this
# machine it prints "Can't recursively copy directory" for every zip, including a flat
# two-file one, and still exits 0 having installed nothing. Verify the artifact by
# extracting it and running tests/headless-verify.sh against the extracted directory.
#
# So: call the packer for what it does right, add what it cannot, then refuse to
# hand over a bundle that is missing anything. The declared lists below are the same
# ones `npm test` cross-checks against the real import graph (tests/repo.test.mjs),
# so a future module split that forgets this file turns CI red instead of shipping
# an inert extension.
set -eu

CDIR=$(cd "$(dirname "$0")/.." && pwd)
SRC=${1:-"$CDIR"}
OUT=${2:-"$CDIR"}

# Everything the packer drops and we must add. Keep in sync with the import graph.
EXTRA_SOURCES="groupEngine.js uiWorkarounds.js"
# arcname == source path, added straight into the zip after packing.
EXTRA_FILES="schemas/gschemas.compiled"

UUID=$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/metadata.json")
[ -n "$UUID" ] || { echo "pack: no uuid in $SRC/metadata.json" >&2; exit 1; }
SCHEMA_ID=$(sed -n 's/.*"settings-schema"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/metadata.json")
[ -n "$SCHEMA_ID" ] || { echo "pack: metadata.json has no settings-schema" >&2; exit 1; }

TMP=$(mktemp -d)
trap '/bin/rm -rf "$TMP"' EXIT

ARGS=()
for f in $EXTRA_SOURCES; do
    [ -f "$SRC/$f" ] || { echo "pack: $f is declared but missing from $SRC" >&2; exit 1; }
    ARGS+=(--extra-source="$f")
done

gnome-extensions pack "$SRC" "${ARGS[@]}" -o "$TMP"
ZIP="$TMP/$UUID.shell-extension.zip"
[ -f "$ZIP" ] || { echo "pack: the packer produced no zip (it can exit 0 and still fail)" >&2; exit 1; }

python3 - "$ZIP" "$SRC" $EXTRA_FILES <<'PY'
import sys, zipfile, os
zip_path, src = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path, 'a') as z:
    for rel in sys.argv[3:]:
        full = os.path.join(src, rel)
        if not os.path.isfile(full):
            sys.exit(f'pack: declared extra file missing: {rel}')
        # arcname == the runtime path, which is the whole point of doing this here.
        z.write(full, rel)
PY

# ---- the completeness gate: not "did the command work", but "can it load" ----
python3 - "$ZIP" "$UUID" "$SCHEMA_ID" <<'PY'
import sys, zipfile
zip_path, uuid, schema = sys.argv[1:4]
REQUIRED = [
    'metadata.json', 'extension.js', 'prefs.js',
    'groupEngine.js', 'uiWorkarounds.js',
    f'schemas/{schema}.gschema.xml', 'schemas/gschemas.compiled',
]
FORBIDDEN = ('.git/', 'tests/', 'reports/', 'node_modules/', 'docs/')
names = set(zipfile.ZipFile(zip_path).namelist())
missing = [f for f in REQUIRED if f not in names]
leaked = sorted(n for n in names if n.startswith(FORBIDDEN))
print(f'{zip_path}')
print(f'  entries: {len([n for n in names if not n.endswith("/")])}')
if missing:
    print('  FAIL missing (the extension would load inert): ' + ', '.join(missing))
if leaked:
    print('  FAIL development files leaked into the bundle: ' + ', '.join(leaked))
if missing or leaked:
    sys.exit(1)
print('  PASS every runtime file present, no development file leaked')
PY

/bin/mv "$ZIP" "$OUT/$UUID.shell-extension.zip"
echo "wrote $OUT/$UUID.shell-extension.zip"
