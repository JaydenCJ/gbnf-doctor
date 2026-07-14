#!/usr/bin/env bash
# Smoke test for gbnf-doctor: exercises the real CLI end to end against the
# bundled examples. No network, idempotent, runs from a clean checkout
# (after `npm install`). Prints "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
CLI="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents every subcommand.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($CLI --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($CLI --help)"
for word in lint test convert; do
  echo "$HELP" | grep -q "$word" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. Error handling: unknown commands and unreadable files exit 2.
set +e
$CLI frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown command should exit 2"; }
$CLI lint "$WORKDIR/nope.gbnf" >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "missing file should exit 2"; }
set -e
echo "[smoke] error handling ok (exit 2)"

# 4. lint: the clean example passes, the broken one fails with the right codes.
OUT="$($CLI lint examples/ipv4.gbnf)" || fail "lint of ipv4.gbnf failed"
echo "$OUT" | grep -q 'OK (0 errors, 0 warnings)' || fail "ipv4.gbnf should lint clean: $OUT"
set +e
BROKEN_OUT="$($CLI lint examples/broken.gbnf)"; BROKEN_CODE=$?
set -e
[ "$BROKEN_CODE" -eq 1 ] || fail "broken.gbnf should exit 1, got $BROKEN_CODE"
for code in E002 E004 W101 W103; do
  echo "$BROKEN_OUT" | grep -q "$code" || fail "broken.gbnf should trigger $code"
done
echo "$BROKEN_OUT" | grep -q 'did you mean "value"' || fail "missing did-you-mean hint"
echo "[smoke] lint ok (clean passes, broken fails with codes + hints)"

# 5. lint --strict flips warnings into failures.
printf 'root ::= "a"\nunused ::= "b"\n' > "$WORKDIR/warn.gbnf"
$CLI lint "$WORKDIR/warn.gbnf" >/dev/null || fail "warnings alone should pass by default"
set +e
$CLI lint "$WORKDIR/warn.gbnf" --strict >/dev/null; STRICT_CODE=$?
set -e
[ "$STRICT_CODE" -eq 1 ] || fail "--strict should exit 1 on warnings, got $STRICT_CODE"
echo "[smoke] --strict ok"

# 6. test: matches, pinpointed rejections, incomplete + --prefix-ok.
$CLI test examples/ipv4.gbnf "127.0.0.1" "192.168.0.1" >/dev/null || fail "valid addresses should match"
set +e
NOMATCH_OUT="$($CLI test examples/ipv4.gbnf "256.1.1.1")"; NOMATCH_CODE=$?
set -e
[ "$NOMATCH_CODE" -eq 1 ] || fail "256.1.1.1 should be rejected with exit 1"
echo "$NOMATCH_OUT" | grep -q 'at offset 2' || fail "rejection should locate offset 2: $NOMATCH_OUT"
echo "$NOMATCH_OUT" | grep -q 'expected' || fail "rejection should list expectations"
set +e
$CLI test examples/ipv4.gbnf "192.168" >/dev/null; INC_CODE=$?
set -e
[ "$INC_CODE" -eq 1 ] || fail "incomplete input should exit 1 by default"
$CLI test examples/ipv4.gbnf "192.168" --prefix-ok >/dev/null || fail "--prefix-ok should accept a valid prefix"
echo "[smoke] test ok (match / no-match diagnosis / prefix mode)"

# 7. test --stdin reads the candidate from stdin.
printf '10.0.0.7' | $CLI test examples/ipv4.gbnf --stdin >/dev/null || fail "--stdin should match"
echo "[smoke] --stdin ok"

# 8. convert: schema -> grammar; the output lints clean with our own linter.
$CLI convert examples/ticket.schema.json --out "$WORKDIR/ticket.gbnf" >/dev/null \
  || fail "convert failed"
grep -q '^root ::= ' "$WORKDIR/ticket.gbnf" || fail "generated grammar missing root"
OUT="$($CLI lint "$WORKDIR/ticket.gbnf")" || fail "generated grammar must lint clean: $OUT"
echo "[smoke] convert ok (generated grammar lints clean)"

# 9. The generated grammar accepts a valid instance and rejects a bad one.
VALID='{"id":"123e4567-e89b-12d3-a456-426614174000","title":"Printer on fire","priority":"high","resolved":false}'
$CLI test "$WORKDIR/ticket.gbnf" "$VALID" >/dev/null || fail "valid ticket JSON should match"
set +e
$CLI test "$WORKDIR/ticket.gbnf" '{"id":"nope"}' >/dev/null; BAD_CODE=$?
set -e
[ "$BAD_CODE" -eq 1 ] || fail "invalid ticket JSON should be rejected"
echo "[smoke] round-trip ok (schema -> grammar -> matcher)"

# 10. Idempotency: converting twice produces byte-identical output.
$CLI convert examples/ticket.schema.json --out "$WORKDIR/ticket2.gbnf" >/dev/null
cmp -s "$WORKDIR/ticket.gbnf" "$WORKDIR/ticket2.gbnf" || fail "regenerated grammar differs"
echo "[smoke] idempotency ok"

echo "SMOKE OK"
