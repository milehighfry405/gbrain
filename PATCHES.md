# Patch Tracking — milehighfry405/gbrain

This fork carries patches on top of upstream `garrytan/gbrain`. Each patch tracks an open upstream PR. When the PR merges, drop the patch.

## Active Patches

### 1. Source ID Routing (PR #639)

**Commit:** `c012d00`
**Upstream PR:** https://github.com/garrytan/gbrain/pull/639
**Author:** electricsheephq
**Issue:** `put_page` and `importFile` always write `source_id='default'` regardless of `--source` flag. Multi-source brains can't route pages to named sources.
**Fix:** Threads optional `sourceId` through `runImport → importFile → putPage` so pages land in the correct source.
**Files changed:** `src/commands/import.ts`, `src/commands/sync.ts`, `src/core/engine.ts`, `src/core/import-file.ts`, `src/core/operations.ts`, `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`, `src/core/types.ts`
**Test:** `./scripts/validate-patches.sh` test 1
**Drop when:** PR #639 (or equivalent) merges to upstream master.

### 2. DB→Markdown Write-Through on put_page (PR #438)

**Commit:** `6f7e545`
**Upstream PR:** https://github.com/garrytan/gbrain/pull/438
**Author:** rayzhux (original), ported by us (write-through only, no auto-link security changes)
**Issue:** Agent `put_page` via MCP writes to DB only. The markdown repo never gets the file, causing repo/DB divergence.
**Fix:** After successful remote `put_page`, renders page back to `${GBRAIN_BRAIN_ROOT}/<slug>.md` via `serializeMarkdown`. Opt-in via `GBRAIN_BRAIN_ROOT` env var.
**Files changed:** `src/core/operations.ts`
**Requires:** `GBRAIN_BRAIN_ROOT` env var set to the brain repo path (e.g., `/data/brain`)
**Test:** `./scripts/validate-patches.sh` test 2
**Drop when:** PR #438 (or equivalent write-through) merges to upstream master.

## Retired Patches

*None yet.*

## Upgrade Workflow

```bash
# 1. Fetch latest upstream
git fetch upstream

# 2. Rebase patches onto new upstream
git checkout ben/patched
git rebase upstream/master

# 3. Three outcomes per patch:
#    - Clean rebase → patch still needed, still works
#    - Conflict on same lines → Garry shipped something. Check if it's THE fix.
#      If yes, drop the patch: git rebase --skip
#    - Tests fail after rebase → investigate

# 4. Run validation
bun install
./scripts/validate-patches.sh

# 5. Push updated branch
git push origin ben/patched --force-with-lease
```

## Adding a New Patch

1. Create the fix on `ben/patched` as a normal commit
2. Reference the upstream PR/issue in the commit message
3. Add an entry to this file under "Active Patches"
4. Add a test to `scripts/validate-patches.sh`
5. Push: `git push origin ben/patched`
