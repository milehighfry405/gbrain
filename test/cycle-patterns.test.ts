/**
 * Unit tests for the patterns phase (v0.21).
 *
 * The phase invokes a subagent and queues real Minions work, so this
 * file leans on structural assertions over the source + a single
 * end-to-end driver run that exercises the skip-paths.
 *
 * Full LLM behavior is exercised by E2E tests in test/e2e/.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const patternsSrc = readFileSync(
  new URL('../src/core/cycle/patterns.ts', import.meta.url),
  'utf-8',
);

describe('patterns phase wiring', () => {
  test('imports queue + waitForCompletion + types', () => {
    expect(patternsSrc).toContain("import { MinionQueue }");
    expect(patternsSrc).toContain('waitForCompletion');
    expect(patternsSrc).toContain('SubagentHandlerData');
  });

  test('threads allowed_slug_prefixes from filing-rules JSON', () => {
    expect(patternsSrc).toContain('allowed_slug_prefixes');
    expect(patternsSrc).toContain('_brain-filing-rules.json');
    expect(patternsSrc).toContain('dream_synthesize_paths');
  });

  test('reads min_evidence + lookback_days config', () => {
    expect(patternsSrc).toContain('dream.patterns.min_evidence');
    expect(patternsSrc).toContain('dream.patterns.lookback_days');
  });

  test('uses subagent_tool_executions for slug provenance (Codex #2 fix)', () => {
    expect(patternsSrc).toContain('subagent_tool_executions');
    expect(patternsSrc).toContain("tool_name = 'brain_put_page'");
  });

  test('skips when ANTHROPIC_API_KEY missing', () => {
    expect(patternsSrc).toContain('ANTHROPIC_API_KEY');
    expect(patternsSrc).toContain('no_api_key');
  });

  test('skips when reflections below min_evidence', () => {
    expect(patternsSrc).toContain('insufficient_evidence');
  });

  test('reverse-writes pages to disk via serializeMarkdown', () => {
    expect(patternsSrc).toContain('serializeMarkdown');
    expect(patternsSrc).toContain('writeFileSync');
  });

  test('runs after extract — queries fresh graph', () => {
    // Documented invariant: pattern phase MUST run after extract.
    // The cycle.ts dispatcher enforces order; this just confirms the
    // patterns module doesn't try to compute its own auto-link layer
    // (which would be a subtle regression).
    expect(patternsSrc).not.toContain('runAutoLink');
    expect(patternsSrc).not.toContain('extractPageLinks(');
  });

  test('does NOT use raw_data table (Codex #3 fix)', () => {
    expect(patternsSrc).not.toContain('putRawData');
    expect(patternsSrc).not.toContain('getRawData');
  });
});

describe('patterns scope filter', () => {
  test('filters reflections by slug LIKE personal/reflections/% (no wiki/ prefix)', () => {
    // workspace-l5o.33: the patterns query MUST match the slug prefix
    // where synth actually writes — `personal/reflections/*` per
    // _brain-filing-rules.json dream_synthesize_paths.globs. The historical
    // `wiki/personal/reflections/` prefix was a stale half-migration that
    // silently broke patterns (insufficient_evidence on every cycle).
    expect(patternsSrc).toContain("slug LIKE 'personal/reflections/%'");
    expect(patternsSrc).not.toContain("'wiki/personal/reflections/%'");
  });

  test('orders by updated_at DESC for recency-bias', () => {
    expect(patternsSrc).toContain('ORDER BY updated_at DESC');
  });

  test('caps gather to 100 reflections (cost control)', () => {
    expect(patternsSrc).toContain('LIMIT 100');
  });
});

describe('patterns/synthesize slug-prefix contract (workspace-l5o.33)', () => {
  const synthSrc = readFileSync(
    new URL('../src/core/cycle/synthesize.ts', import.meta.url),
    'utf-8',
  );
  const filingRulesJson = JSON.parse(readFileSync(
    new URL('../skills/_brain-filing-rules.json', import.meta.url),
    'utf-8',
  )) as { dream_synthesize_paths?: { globs?: string[] } };
  const allowlistGlobs = filingRulesJson.dream_synthesize_paths?.globs ?? [];

  test('allowlist contains personal/reflections/* (where synth writes)', () => {
    expect(allowlistGlobs).toContain('personal/reflections/*');
  });

  test('allowlist contains personal/patterns/* (where patterns writes)', () => {
    expect(allowlistGlobs).toContain('personal/patterns/*');
  });

  test('allowlist has no stale wiki/ globs', () => {
    for (const g of allowlistGlobs) {
      expect(g).not.toMatch(/^wiki\//);
    }
  });

  test('synthesize prompt instructs reflection slug = personal/reflections/...', () => {
    expect(synthSrc).toContain('personal/reflections/${dateHint}-<topic-slug>-${hashSuffix}');
    expect(synthSrc).not.toContain('wiki/personal/reflections/${dateHint}');
  });

  test('synthesize prompt instructs original slug = originals/<flat>... (per RESOLVER.md)', () => {
    // RESOLVER.md disambiguation rules: `originals/` = your thinking (frameworks,
    // takes, predictions) at TOP LEVEL flat. `ideas/` = things to build, SEPARATE
    // top-level dir. Synth writes "your original thinking" → MUST land in `originals/`
    // flat, NEVER nested under `originals/ideas/`. Disk reality: 32 originals at
    // /data/brain/originals/*.md (flat); the 1 page that briefly drifted in the
    // 2026-05-24 quiet-magnolia session ended up at originals/ideas/ (since moved).
    expect(synthSrc).toContain('originals/${dateHint}-<idea-slug>-${hashSuffix}');
    // Regression guard — both stale variants forbidden.
    expect(synthSrc).not.toContain('wiki/originals/');
    expect(synthSrc).not.toContain('originals/ideas/${dateHint}');
  });

  test('filing-rules doc instructs original slug = originals/<flat>... (no ideas/ nest)', () => {
    const filingRulesMd = readFileSync(
      new URL('../skills/_brain-filing-rules.md', import.meta.url),
      'utf-8',
    );
    // Catches drift between code prompt + human-facing doc.
    expect(filingRulesMd).toMatch(/originals\/YYYY-MM-DD-<idea>/);
    expect(filingRulesMd).not.toMatch(/originals\/ideas\/YYYY-MM-DD-<idea>/);
  });

  test('maintain skill doc references originals/ flat (no ideas/ nest)', () => {
    const maintainSkill = readFileSync(
      new URL('../skills/maintain/SKILL.md', import.meta.url),
      'utf-8',
    );
    expect(maintainSkill).not.toMatch(/originals\/ideas\//);
  });

  test('patterns prompt instructs pattern slug = personal/patterns/<topic>', () => {
    expect(patternsSrc).toContain('personal/patterns/<topic-slug>');
    expect(patternsSrc).not.toContain('wiki/personal/patterns/<topic-slug>');
  });

  test('patterns query prefix is covered by the synthesize allowlist (closed loop)', () => {
    // The patterns phase queries reflections written by synthesize. The
    // query prefix MUST be one that the allowlist permits, otherwise the
    // patterns phase silently degrades to skipped('insufficient_evidence').
    const queryPrefix = 'personal/reflections/';
    const covered = allowlistGlobs.some(g => {
      if (g.endsWith('/*')) return queryPrefix.startsWith(g.slice(0, -2) + '/');
      return queryPrefix.startsWith(g);
    });
    expect(covered).toBe(true);
  });
});
