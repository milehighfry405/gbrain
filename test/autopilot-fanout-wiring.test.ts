/**
 * v0.38 — static-shape regression for autopilot.ts ↔ dispatchPerSource wiring.
 *
 * autopilot.ts's `shouldFullCycle` branch was rewired in this wave to
 * call `dispatchPerSource` from autopilot-fanout.ts instead of
 * submitting one `autopilot-cycle` job per tick. Because the autopilot
 * loop is deep inside `runAutopilot()` and gated by a connected engine,
 * a full integration test would require a Postgres fixture. The fan-out
 * helper itself has 27 unit tests + 6 PGLite/Postgres parity tests; this
 * file pins the WIRING in autopilot.ts so a future refactor that
 * accidentally reverts to single-job dispatch fails this guard first.
 *
 * Same pattern as test/autopilot-supervisor-wiring.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

describe('autopilot.ts ↔ dispatchPerSource wiring', () => {
  test('imports dispatchPerSource from the fan-out helper', () => {
    expect(AUTOPILOT_SRC).toMatch(
      /(import\s+.*dispatchPerSource.*from\s+['"]\.\/autopilot-fanout\.ts['"]|await import\(['"]\.\/autopilot-fanout\.ts['"]\))/,
    );
  });

  test('imports resolveFanoutMax (so PGLite gets fanoutMax=1 per codex P1-3)', () => {
    expect(AUTOPILOT_SRC).toMatch(/resolveFanoutMax/);
  });

  test('calls dispatchPerSource within the shouldFullCycle branch', () => {
    // dispatchPerSource must appear in the same hot path as the
    // pre-fix `queue.add('autopilot-cycle', ...)` did — i.e. when
    // shouldFullCycle is true, not in the targeted-plan path.
    const dispatchIdx = AUTOPILOT_SRC.indexOf('dispatchPerSource(engine, queue');
    expect(dispatchIdx).toBeGreaterThan(-1);
    // Verify shouldFullCycle is structurally near the call (within
    // ~3000 chars of source, roughly the same if/else branch)
    const fullCycleIdx = AUTOPILOT_SRC.indexOf('shouldFullCycle');
    expect(fullCycleIdx).toBeGreaterThan(-1);
    expect(Math.abs(dispatchIdx - fullCycleIdx)).toBeLessThan(3000);
  });

  test('gates dispatch on decideDispatchMode (per-source freshness, not process-local watermark)', () => {
    // workspace-l5o.20: the pre-fix gate keyed on a process-local
    // `lastFullCycleAt` + brain_score band. On a healthy
    // Postgres+Minions brain in [70, 95) with empty plan, NONE of the
    // clauses fired AND shouldSleep was false, so dispatchPerSource
    // never ran and `last_full_cycle_at` watermarks never advanced →
    // `doctor:cycle_freshness` FAILed forever. Fix replaces the inline
    // gate with `decideDispatchMode` (pure fn in autopilot-fanout.ts)
    // that consults per-source `isSourceStale`. This test pins the
    // wiring so a future refactor that reverts to a process-local
    // watermark fails here first.
    expect(AUTOPILOT_SRC).toMatch(/decideDispatchMode/);
    // And the legacy process-local var must NOT come back.
    expect(AUTOPILOT_SRC).not.toMatch(/let\s+lastFullCycleAt\s*=/);
    expect(AUTOPILOT_SRC).not.toMatch(/lastFullCycleAt\s*=\s*Date\.now\(\)/);
  });

  test('does NOT regress to the single-job dispatch on the full-cycle path', () => {
    // Pre-PR: the shouldFullCycle branch did:
    //   const job = await queue.add('autopilot-cycle', { repoPath }, {
    //     idempotency_key: `autopilot-cycle:${slot}`, ...
    //   });
    // If a future refactor reintroduces this exact pattern in autopilot.ts,
    // the per-source fan-out has been silently reverted.
    //
    // Allow the legacy idempotency key shape ONLY inside dispatchPerSource's
    // fallback path (which is in autopilot-fanout.ts, not autopilot.ts).
    expect(AUTOPILOT_SRC).not.toMatch(/queue\.add\(['"]autopilot-cycle['"][\s\S]{0,400}idempotency_key:\s*`autopilot-cycle:\$\{slot\}`/);
  });
});
