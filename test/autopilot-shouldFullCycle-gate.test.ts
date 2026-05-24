/**
 * workspace-l5o.20 — `decideDispatchMode` pure-function gate.
 *
 * Pre-fix bug (autopilot.ts:443): on a healthy Postgres+Minions cockpit
 * with `brain_score ∈ [70, 95)` and a small plan, NONE of the inline
 * `shouldFullCycle` clauses fired AND `shouldSleep` was false either, so
 * control fell through to the targeted-submit branch which never invokes
 * `dispatchPerSource`. Sources accumulated NULL `last_full_cycle_at`
 * forever → `doctor:cycle_freshness` reported FAIL permanently.
 *
 * Fix: replace the inline gate with `decideDispatchMode` (this file's
 * subject) which consults per-source `isSourceStale` first. The
 * score/plan escape hatches survive for unhealthy brains; `shouldSleep`
 * triggers only when all sources are fresh AND the plan is empty.
 *
 * Pure unit tests — no engine fixture, no daemon. The wiring into
 * `autopilot.ts` is pinned by `test/autopilot-fanout-wiring.test.ts`.
 */
import { describe, test, expect } from 'bun:test';
import { decideDispatchMode } from '../src/commands/autopilot-fanout.ts';
import type { SourceRow } from '../src/core/engine.ts';

const NOW = Date.UTC(2026, 4, 24, 12, 0, 0); // 2026-05-24T12:00:00Z

function src(id: string, last_full_cycle_at?: string | null): SourceRow {
  return {
    id,
    name: null,
    local_path: `/tmp/${id}`,
    last_sync_at: null,
    config: last_full_cycle_at !== undefined && last_full_cycle_at !== null
      ? { last_full_cycle_at }
      : {},
  };
}

function isoMinutesAgo(mins: number): string {
  return new Date(NOW - mins * 60_000).toISOString();
}

describe('decideDispatchMode — workspace-l5o.20 gate', () => {
  test('case 1: all sources fresh + score=82 + plan empty → sleep, no full cycle', () => {
    const sources = [src('alpha', isoMinutesAgo(5)), src('beta', isoMinutesAgo(30))];
    const result = decideDispatchMode({
      sources,
      plan: { length: 0 },
      estTotalSec: 0,
      brainScore: 82,
      now: NOW,
    });
    expect(result).toEqual({
      shouldFullCycle: false,
      shouldSleep: true,
      anyStaleSource: false,
    });
  });

  test('case 2: one source has NULL last_full_cycle_at + score=82 + plan empty → full cycle, no sleep', () => {
    // NULL last_full_cycle_at is the never-cycled signal (isSourceStale → true).
    const sources = [src('alpha', isoMinutesAgo(5)), src('beta', null)];
    const result = decideDispatchMode({
      sources,
      plan: { length: 0 },
      estTotalSec: 0,
      brainScore: 82,
      now: NOW,
    });
    expect(result).toEqual({
      shouldFullCycle: true,
      shouldSleep: false,
      anyStaleSource: true,
    });
  });

  test('case 3: one source >60min stale + score=82 + plan empty → full cycle, no sleep', () => {
    const sources = [src('alpha', isoMinutesAgo(5)), src('beta', isoMinutesAgo(75))];
    const result = decideDispatchMode({
      sources,
      plan: { length: 0 },
      estTotalSec: 0,
      brainScore: 82,
      now: NOW,
    });
    expect(result).toEqual({
      shouldFullCycle: true,
      shouldSleep: false,
      anyStaleSource: true,
    });
  });

  test('case 4: all sources fresh + score=50 → full cycle via score<70 escape hatch', () => {
    const sources = [src('alpha', isoMinutesAgo(5)), src('beta', isoMinutesAgo(10))];
    const result = decideDispatchMode({
      sources,
      plan: { length: 0 },
      estTotalSec: 0,
      brainScore: 50,
      now: NOW,
    });
    expect(result.shouldFullCycle).toBe(true);
    expect(result.shouldSleep).toBe(false);
    expect(result.anyStaleSource).toBe(false);
  });

  test('case 5: all sources fresh + plan.length=5 → full cycle via plan>3 escape hatch', () => {
    const sources = [src('alpha', isoMinutesAgo(5))];
    const result = decideDispatchMode({
      sources,
      plan: { length: 5 },
      estTotalSec: 60,
      brainScore: 82,
      now: NOW,
    });
    expect(result.shouldFullCycle).toBe(true);
    expect(result.shouldSleep).toBe(false);
    expect(result.anyStaleSource).toBe(false);
  });

  test('case 6: all sources fresh + estTotalSec=600 → full cycle via estTotal>=300 escape hatch', () => {
    const sources = [src('alpha', isoMinutesAgo(5))];
    const result = decideDispatchMode({
      sources,
      plan: { length: 2 },
      estTotalSec: 600,
      brainScore: 82,
      now: NOW,
    });
    expect(result.shouldFullCycle).toBe(true);
    expect(result.shouldSleep).toBe(false);
    expect(result.anyStaleSource).toBe(false);
  });

  test('case 7: empty sources array (legacy/fresh-install) + plan empty + score=82 → sleep, NOT churn', () => {
    // Legacy/fresh-install: listAllSources({localPathOnly:true}) returns
    // []. dispatchPerSource's own legacy fallback handles the case where
    // the gate DOES fire (plan>3, score<70, etc.). The outer gate here
    // should sleep when there's nothing to do, NOT spin up a no-op
    // per-tick cycle.
    const result = decideDispatchMode({
      sources: [],
      plan: { length: 0 },
      estTotalSec: 0,
      brainScore: 82,
      now: NOW,
    });
    expect(result).toEqual({
      shouldFullCycle: false,
      shouldSleep: true,
      anyStaleSource: false,
    });
  });

  test('floorMin override: a 30-min-stale source is fresh under a 60-min floor but stale under a 15-min floor', () => {
    const sources = [src('alpha', isoMinutesAgo(30))];
    const defaultFloor = decideDispatchMode({
      sources,
      plan: { length: 0 },
      estTotalSec: 0,
      brainScore: 82,
      now: NOW,
    });
    expect(defaultFloor.anyStaleSource).toBe(false);

    const tightFloor = decideDispatchMode({
      sources,
      plan: { length: 0 },
      estTotalSec: 0,
      brainScore: 82,
      now: NOW,
      floorMin: 15,
    });
    expect(tightFloor.anyStaleSource).toBe(true);
    expect(tightFloor.shouldFullCycle).toBe(true);
  });
});
