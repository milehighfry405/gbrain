/**
 * v0.38 workspace-4x5 — autopilot inline-fallback per-source dispatch.
 *
 * Fixes a P0 observability gap: the inline-fallback path (PGLite,
 * `--inline`, or `minion_mode=off`) used to call runCycle WITHOUT a
 * sourceId, so the watermark write at `cycle.ts:1730` (gated on
 * `opts.sourceId`) silently never fired. `doctor:cycle_freshness` then
 * reported FAIL on a brain whose daemon was running fine — pure
 * observability bug, not a real freshness gap.
 *
 * `runInlineCycleTick` now mirrors the Minions `dispatchPerSource`
 * semantics (per-source serial dispatch, per-source `pull` from
 * `remote_url`, fanoutMax cap) but runs synchronously in-process — no
 * job queue indirection — and threads `sourceId` into every runCycle
 * call. That's the fix.
 *
 * NOTE: the sibling `cycle-last-full-cycle-at.test.ts` still asserts the
 * legacy "no sourceId → no write" contract on `runCycle` directly. That
 * test is unchanged; it tests `cycle.ts` in isolation, which is correct.
 * This file tests the INLINE-PATH wiring on top of that gate.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runInlineCycleTick } from '../src/commands/autopilot.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-inline-'));
});

async function seedSource(id: string, config: Record<string, unknown> = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, $4::jsonb, false, NOW())
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [id, id, brainDir, JSON.stringify(config)],
  );
}

async function readLastFullCycleAt(sourceId: string): Promise<string | null> {
  const sources = await engine.listAllSources();
  const s = sources.find(x => x.id === sourceId);
  if (!s) return null;
  const raw = s.config?.last_full_cycle_at;
  return typeof raw === 'string' ? raw : null;
}

describe('runInlineCycleTick — per-source watermark write (workspace-4x5)', () => {
  test('writes last_full_cycle_at for a seeded source after one tick', async () => {
    // Default source seeded by resetPgliteState has NO local_path, so the
    // `localPathOnly: true` filter would skip it. Add a real one.
    await seedSource('alpha');

    const before = await readLastFullCycleAt('alpha');
    expect(before).toBeNull();

    const t0 = Date.now();
    const ok = await runInlineCycleTick(engine, { repoPath: brainDir, jsonMode: true });
    expect(ok).toBe(true);

    const after = await readLastFullCycleAt('alpha');
    expect(after).not.toBeNull();
    const writtenMs = new Date(after!).getTime();
    expect(writtenMs).toBeGreaterThanOrEqual(t0);
    expect(writtenMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('with 2 sources on PGLite (fanoutMax=1), oldest-first source gets the watermark this tick', async () => {
    // Two sources, both never cycled (both stale, NULL last_full_cycle_at).
    // PGLite fanoutMax=1 caps dispatch to one; selectSourcesForDispatch
    // breaks NULL-timestamp ties by id (alphabetical, ascending), so
    // 'alpha' should dispatch first.
    await seedSource('alpha');
    await seedSource('beta');

    const ok = await runInlineCycleTick(engine, { repoPath: brainDir, jsonMode: true });
    expect(ok).toBe(true);

    const alphaAfter = await readLastFullCycleAt('alpha');
    const betaAfter = await readLastFullCycleAt('beta');

    // PGLite cap = 1; alpha (alphabetically first among NULL-timestamp ties)
    // dispatches and gets the watermark. beta retries next tick.
    expect(alphaAfter).not.toBeNull();
    expect(betaAfter).toBeNull();
  });

  test('returns true (healthy) on a successful cycle', async () => {
    await seedSource('alpha');
    const ok = await runInlineCycleTick(engine, { repoPath: brainDir, jsonMode: false });
    expect(ok).toBe(true);
  });

  test('skips fresh source and writes nothing when fully fresh', async () => {
    // Seed with a recent last_full_cycle_at so the source is below the
    // 60-min freshness floor — selectSourcesForDispatch should skip it.
    const recent = new Date().toISOString();
    await seedSource('alpha', { last_full_cycle_at: recent });

    const ok = await runInlineCycleTick(engine, { repoPath: brainDir, jsonMode: true });
    expect(ok).toBe(true);

    // Watermark should NOT have advanced (no cycle ran for alpha).
    const after = await readLastFullCycleAt('alpha');
    expect(after).toBe(recent);
  });

  test('legacy-shape brain (no local-path sources) falls through to single runCycle without sourceId', async () => {
    // No seeded sources with local_path set. The default source has
    // local_path=NULL, so listAllSources({localPathOnly:true}) returns
    // empty → legacy single-runCycle path → no sourceId → no watermark
    // write on any source. This preserves pre-fix behavior for brains
    // that haven't adopted the sources-with-local_path pattern.
    const ok = await runInlineCycleTick(engine, { repoPath: brainDir, jsonMode: true });
    expect(ok).toBe(true);

    const defaultAfter = await readLastFullCycleAt('default');
    expect(defaultAfter).toBeNull();
  });
});
