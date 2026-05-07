#!/bin/bash
# validate-patches.sh — Run after every rebase or upgrade.
# Tests each patch in PATCHES.md to verify it's still working.
# Exit 0 = all patches valid. Non-zero = something broke.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FORK_DIR="$(dirname "$SCRIPT_DIR")"
BRAIN_ROOT="${GBRAIN_BRAIN_ROOT:-}"
PASS=0
FAIL=0
SKIP=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }

echo "=== gbrain patch validation ==="
echo "Fork: $FORK_DIR"
echo "Branch: $(cd "$FORK_DIR" && git branch --show-current)"
echo ""

# --- Pre-flight ---
echo "--- Pre-flight: typecheck ---"
cd "$FORK_DIR"
if ./node_modules/.bin/tsc --noEmit 2>/dev/null; then
  green "PASS: typecheck clean"
  PASS=$((PASS + 1))
else
  red "FAIL: typecheck errors"
  FAIL=$((FAIL + 1))
fi
echo ""

# --- Test 1: Source ID Routing (PR #639) ---
echo "--- Test 1: Source ID Routing (PR #639) ---"
echo "Checks: does sync --source <id> route pages to the named source?"

# Check if the patch exists in the code
if grep -q "sourceId.*opts\.\|opts.*sourceId" "$FORK_DIR/src/commands/import.ts" 2>/dev/null; then
  green "PASS: sourceId threading present in import.ts"
  PASS=$((PASS + 1))
else
  red "FAIL: sourceId threading missing from import.ts — patch may have been dropped"
  FAIL=$((FAIL + 1))
fi

if grep -q "sourceId" "$FORK_DIR/src/core/import-file.ts" 2>/dev/null; then
  green "PASS: sourceId present in import-file.ts"
  PASS=$((PASS + 1))
else
  red "FAIL: sourceId missing from import-file.ts"
  FAIL=$((FAIL + 1))
fi

# Check if upstream fixed it (putPage accepts sourceId natively)
if grep -q "Step 5.*will surface.*sourceId" "$FORK_DIR/src/core/postgres-engine.ts" 2>/dev/null; then
  yellow "NOTE: 'Step 5 will surface sourceId' comment still present — upstream hasn't shipped the fix yet"
else
  yellow "NOTE: Step 5 comment gone — upstream may have shipped the fix. Check if patch is still needed."
fi
echo ""

# --- Test 2: Write-Through (PR #438) ---
echo "--- Test 2: DB→Markdown Write-Through (PR #438) ---"
echo "Checks: does put_page render .md to disk when GBRAIN_BRAIN_ROOT is set?"

if grep -q "exportToBrainRepo" "$FORK_DIR/src/core/operations.ts" 2>/dev/null; then
  green "PASS: exportToBrainRepo function present in operations.ts"
  PASS=$((PASS + 1))
else
  red "FAIL: exportToBrainRepo missing from operations.ts — patch may have been dropped"
  FAIL=$((FAIL + 1))
fi

if grep -q "brain_export" "$FORK_DIR/src/core/operations.ts" 2>/dev/null; then
  green "PASS: brain_export response field present"
  PASS=$((PASS + 1))
else
  red "FAIL: brain_export response field missing"
  FAIL=$((FAIL + 1))
fi

if grep -q "GBRAIN_BRAIN_ROOT" "$FORK_DIR/src/core/operations.ts" 2>/dev/null; then
  green "PASS: GBRAIN_BRAIN_ROOT env var check present"
  PASS=$((PASS + 1))
else
  red "FAIL: GBRAIN_BRAIN_ROOT env var check missing"
  FAIL=$((FAIL + 1))
fi

# Check if upstream fixed it
if grep -q "exportToBrainRepo\|GBRAIN_BRAIN_ROOT" "$FORK_DIR/src/core/operations.ts" 2>/dev/null; then
  # Could be our patch or upstream's fix — either way it's there
  true
fi
echo ""

# --- Test 3: Upstream PR status check ---
echo "--- Test 3: Upstream PR Status ---"
echo "Checking if tracked PRs have been merged..."

if command -v gh &>/dev/null; then
  for pr in 639 438; do
    state=$(gh pr view "$pr" --repo garrytan/gbrain --json state -q '.state' 2>/dev/null || echo "UNKNOWN")
    if [ "$state" = "MERGED" ]; then
      yellow "PR #$pr: MERGED — this patch may no longer be needed. Rebase and test."
    elif [ "$state" = "OPEN" ]; then
      green "PR #$pr: OPEN — patch still needed"
    else
      yellow "PR #$pr: $state"
    fi
  done
  PASS=$((PASS + 1))
else
  yellow "SKIP: gh CLI not available — can't check PR status"
  SKIP=$((SKIP + 1))
fi
echo ""

# --- Summary ---
echo "=== Results ==="
green "PASS: $PASS"
if [ "$FAIL" -gt 0 ]; then
  red "FAIL: $FAIL"
fi
if [ "$SKIP" -gt 0 ]; then
  yellow "SKIP: $SKIP"
fi

if [ "$FAIL" -gt 0 ]; then
  echo ""
  red "Some patches are broken. Check PATCHES.md for fix instructions."
  exit 1
fi

echo ""
green "All patches validated."
exit 0
