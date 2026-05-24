import { describe, test, expect, beforeAll } from 'bun:test';

/**
 * workspace-l5o.21 regression — `gbrain jobs submit` data-payload parsing.
 *
 * Bug: prior to v0.40.2.1 only `--params <JSON>` was recognised. Both the
 * `--data <JSON>` flag form AND the positional JSON argument
 * (`gbrain jobs submit <name> '<JSON>'`) were silently dropped, producing
 * a `Data: {}` row in `minion_jobs` with no operator-visible error.
 * Worker handlers received no payload, breaking manual job triggers
 * (e.g. autopilot-cycle with controlled source_id → skipped watermark
 * write at cycle.ts:~1730).
 *
 * Fix: extracted `parseSubmitDataFlag()` accepts all three forms,
 * rejects ambiguity (multiple forms supplied), and errors cleanly on
 * invalid / non-object JSON. The CLI handler at `case 'submit'` wraps
 * the throw with `process.exit(1)`.
 *
 * These tests exercise the parser directly — fast, deterministic,
 * no DB. End-to-end CLI plumbing (process.exit on throw, dry-run output
 * format) is already covered by the existing `--dry-run` smoke flow
 * exercised manually in the bead repro.
 *
 * `args` shape mirrors what `runJobs(engine, args)` receives: the leading
 * `'submit'` subcommand at args[0], the handler name at args[1], then
 * positional JSON / flags from args[2] onward.
 */

let parseSubmitDataFlag: (args: string[]) => Record<string, unknown>;

beforeAll(async () => {
  parseSubmitDataFlag = (await import('../src/commands/jobs.ts')).parseSubmitDataFlag;
});

describe('parseSubmitDataFlag (workspace-l5o.21)', () => {
  // --- The five cases mandated by the bead AC ---

  test('positional JSON arg → parsed object (regression: was silently dropped)', () => {
    const args = ['submit', 'autopilot-cycle', '{"repoPath":"/data/brain","source_id":"default","pull":false}'];
    expect(parseSubmitDataFlag(args)).toEqual({
      repoPath: '/data/brain',
      source_id: 'default',
      pull: false,
    });
  });

  test('--data flag → parsed object (regression: was silently dropped)', () => {
    const args = [
      'submit',
      'autopilot-cycle',
      '--data',
      '{"repoPath":"/data/brain","source_id":"default","pull":false}',
    ];
    expect(parseSubmitDataFlag(args)).toEqual({
      repoPath: '/data/brain',
      source_id: 'default',
      pull: false,
    });
  });

  test('positional and --data produce the same parsed object (forms are equivalent)', () => {
    const payload = '{"foo":"bar","n":42,"nested":{"k":true}}';
    const positional = parseSubmitDataFlag(['submit', 'noop', payload]);
    const flagged = parseSubmitDataFlag(['submit', 'noop', '--data', payload]);
    const paramsForm = parseSubmitDataFlag(['submit', 'noop', '--params', payload]);
    expect(positional).toEqual(flagged);
    expect(flagged).toEqual(paramsForm);
  });

  test('invalid JSON throws with a descriptive message (no silent {} fallback)', () => {
    // Positional invalid JSON
    expect(() =>
      parseSubmitDataFlag(['submit', 'noop', '{not valid json'])
    ).toThrow(/data payload must be valid JSON/);
    // --data invalid JSON
    expect(() =>
      parseSubmitDataFlag(['submit', 'noop', '--data', '{"unterminated'])
    ).toThrow(/data payload must be valid JSON/);
    // --params invalid JSON (backwards-compat path also routes through the
    // new helper and gets the same error voice)
    expect(() =>
      parseSubmitDataFlag(['submit', 'noop', '--params', 'not json at all'])
    ).toThrow(/data payload must be valid JSON/);
  });

  test('empty (no payload form supplied) → explicit {} (not the silent-drop path)', () => {
    expect(parseSubmitDataFlag(['submit', 'noop'])).toEqual({});
    // With unrelated downstream flags but no data payload — still {}.
    expect(
      parseSubmitDataFlag(['submit', 'noop', '--priority', '5', '--queue', 'default'])
    ).toEqual({});
  });

  // --- Edge cases that make the parser load-bearing ---

  test('--params still works (backwards compat — unchanged behaviour for existing users)', () => {
    const args = ['submit', 'embed', '--params', '{"all":true}'];
    expect(parseSubmitDataFlag(args)).toEqual({ all: true });
  });

  test('multiple data sources (--params + --data) → throws ambiguity error', () => {
    expect(() =>
      parseSubmitDataFlag([
        'submit',
        'embed',
        '--params',
        '{"a":1}',
        '--data',
        '{"b":2}',
      ])
    ).toThrow(/multiple data sources/);
  });

  test('multiple data sources (positional + --data) → throws ambiguity error', () => {
    expect(() =>
      parseSubmitDataFlag(['submit', 'embed', '{"a":1}', '--data', '{"b":2}'])
    ).toThrow(/multiple data sources/);
  });

  test('positional that is NOT JSON-shaped (no leading { or [) is ignored — not misparsed', () => {
    // E.g. an operator typo: `gbrain jobs submit foo bar` — `bar` is not
    // a JSON object, so the parser leaves data as {} rather than throwing
    // a confusing JSON error. The submit handler will still proceed with
    // an empty payload (matching the pre-bug behaviour).
    expect(parseSubmitDataFlag(['submit', 'noop', 'bar'])).toEqual({});
    // Same for tokens that look like option values for other flags.
    expect(parseSubmitDataFlag(['submit', 'noop', 'default'])).toEqual({});
  });

  test('JSON array payload → throws (queue.add expects an object)', () => {
    expect(() =>
      parseSubmitDataFlag(['submit', 'noop', '--data', '[1,2,3]'])
    ).toThrow(/must be a JSON object/);
  });

  test('JSON null payload → throws (queue.add expects an object)', () => {
    expect(() =>
      parseSubmitDataFlag(['submit', 'noop', '--data', 'null'])
    ).toThrow(/must be a JSON object/);
  });

  test('JSON scalar payload (string) → throws (queue.add expects an object)', () => {
    // Note: a bare quoted string would need to start with `"` which isn't
    // in our positional sigil set ({, [), so it can only arrive via --data.
    expect(() =>
      parseSubmitDataFlag(['submit', 'noop', '--data', '"hello"'])
    ).toThrow(/must be a JSON object/);
  });
});
