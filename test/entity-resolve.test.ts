import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  resolveEntitySlug,
  resolveEntitySlugWithSource,
  slugify,
  HYPHEN_PREFIX_REWRITE_SORTED,
  type ResolutionSource,
} from '../src/core/entities/resolve.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * Entity resolution prefix expansion tests.
 *
 * Validates that bare first names resolve to existing pages via prefix
 * expansion, preventing phantom stub creation.
 *
 * Fixture names use the `alice-example` / `bob-example` / `charlie-example`
 * / `dave-example` placeholder pattern per CLAUDE.md privacy rule.
 * `stripe` and `stripe-atlas` are intentional — household-brand exception
 * exercises the two-word company prefix case.
 */

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();

  // Seed test pages. Naming pattern:
  //   - alice-example: single-match case (only people/alice-*)
  //   - bob-example vs bob-rosenstein: multi-match tiebreaker (bob-example wins on connections)
  //   - charlie-example vs charlie-bankcroft: multi-match tiebreaker (charlie-example wins on connections)
  //   - dave-example: single-match case
  const pages = [
    { slug: 'people/alice-example', title: 'Alice Example', type: 'person' },
    { slug: 'people/bob-example', title: 'Bob Example', type: 'person' },
    { slug: 'people/bob-rosenstein', title: 'Bob Rosenstein', type: 'person' },
    { slug: 'people/charlie-example', title: 'Charlie Example', type: 'person' },
    { slug: 'people/charlie-bankcroft', title: 'Charlie Bankcroft', type: 'person' },
    { slug: 'people/dave-example', title: 'Dave Example', type: 'person' },
    { slug: 'companies/stripe', title: 'Stripe', type: 'company' },
    { slug: 'companies/stripe-atlas', title: 'Stripe Atlas', type: 'company' },
    // workspace-i75 collision boundary: `people-organizations` has no
    // exact `people/organizations` page, but `people/organizations-*`
    // exists. Pins that the expansion path (not the exact path) wins.
    { slug: 'people/organizations-foo', title: 'Organizations Foo', type: 'person' },
    // workspace-i75 greedy-longest demo: `personal/` is a registered
    // dir; `personal-reflections-foo` rewrites to `personal/reflections-foo`
    // via the existing (single-token-dir) path. When/if a future
    // `personal-reflections/` dir gets added to HYPHEN_PREFIX_REWRITE_DIRS,
    // the sort invariant guarantees it wins over `personal/`.
    { slug: 'personal/reflections-foo', title: 'Reflections Foo', type: 'concept' },
  ];

  for (const p of pages) {
    await engine.putPage(p.slug, {
      type: p.type as any,
      title: p.title,
      compiled_truth: `# ${p.title}`,
      frontmatter: { type: p.type, title: p.title, slug: p.slug },
    }, { sourceId: 'default' });
  }

  // Give alice-example 10 chunks (single match, ensures it's the resolved target)
  const alicePage = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = 'people/alice-example' AND source_id = 'default'`,
    [],
  );
  if (alicePage.length > 0) {
    for (let i = 0; i < 10; i++) {
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [alicePage[0].id, i, `Chunk ${i} about Alice Example`],
      );
    }
  }

  // Give charlie-example more connections than charlie-bankcroft (20 vs 0)
  const charliePage = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = 'people/charlie-example' AND source_id = 'default'`,
    [],
  );
  if (charliePage.length > 0) {
    for (let i = 0; i < 20; i++) {
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [charliePage[0].id, i, `Chunk ${i} about Charlie Example`],
      );
    }
  }

  // Give bob-example more connections than bob-rosenstein (15 vs 0)
  const bobPage = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = 'people/bob-example' AND source_id = 'default'`,
    [],
  );
  if (bobPage.length > 0) {
    for (let i = 0; i < 15; i++) {
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [bobPage[0].id, i, `Chunk ${i} about Bob Example`],
      );
    }
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('resolveEntitySlug — prefix expansion', () => {
  it('resolves "Alice" to people/alice-example', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Alice');
    expect(result).toBe('people/alice-example');
  });

  it('resolves "alice" (lowercase) to people/alice-example', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'alice');
    expect(result).toBe('people/alice-example');
  });

  it('resolves "Bob" to people/bob-example (more connections)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Bob');
    expect(result).toBe('people/bob-example');
  });

  it('resolves "Charlie" to people/charlie-example (more connections)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Charlie');
    expect(result).toBe('people/charlie-example');
  });

  it('resolves "Dave" to people/dave-example (single match)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Dave');
    expect(result).toBe('people/dave-example');
  });

  it('falls through to slugify for unknown names', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Zyxwvut');
    expect(result).toBe('zyxwvut');
  });

  it('exact match still works for fully-qualified slugs', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people/alice-example');
    expect(result).toBe('people/alice-example');
  });

  it('multi-word input does NOT trigger prefix expansion', async () => {
    // "Alice Example" should go through fuzzy match, not prefix expansion
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Alice Example');
    // Should resolve via fuzzy match to the same page
    expect(result).toContain('alice-example');
  });

  it('hyphenated input does NOT trigger prefix expansion', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'alice-example');
    expect(result).toBe('people/alice-example');
  });

  it('returns null for empty input', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', '');
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// workspace-i75 — hyphen-prefix-rewrite step
// ─────────────────────────────────────────────────────────────────────
//
// When the LLM extractor emits `people-ben`, `companies-arthur`, etc.,
// the resolver detects the hyphen-prefix shape, slices off the
// directory token, and tries `<dir>/<rest>` (exact) then
// `<dir>/<rest>-%` (expansion). Empirically: stub-guard audit log
// showed `people-ben` x43, `companies-palantir` x3, etc. before this
// step existed.

describe('resolveEntitySlug — hyphen-prefix rewrite', () => {
  it('rewrites "people-alice" to people/alice-example (prefix expansion)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people-alice');
    expect(result).toBe('people/alice-example');
  });

  it('rewrites "people-bob" to people/bob-example (multi-match, connection tiebreak)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people-bob');
    expect(result).toBe('people/bob-example');
  });

  it('rewrites "companies-stripe" to companies/stripe (exact bare-child match)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'companies-stripe');
    expect(result).toBe('companies/stripe');
  });

  it('rewrites "companies-stripe-atlas" via exact match on rest', async () => {
    // dir=companies, rest=stripe-atlas → exact match on companies/stripe-atlas
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'companies-stripe-atlas');
    expect(result).toBe('companies/stripe-atlas');
  });

  it('does NOT rewrite unknown-directory prefix "data-claude-conventions" (falls through to slugify)', async () => {
    // `data/` is not a brain directory — no rewrite, no fuzzy hit, no
    // bare-name expansion (hyphenated → isBareName false). Slugify
    // returns the input unchanged.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'data-claude-conventions');
    expect(result).toBe('data-claude-conventions');
  });

  it('does NOT rewrite when the rest matches no page (falls through)', async () => {
    // `people/` is a known dir but `people/zzznonexistent-*` matches nothing.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people-zzznonexistent');
    expect(result).toBe('people-zzznonexistent');
  });

  it('does NOT rewrite a leading-hyphen-only slug', async () => {
    // No directory token to slice — first hyphen at position 0.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', '-trailing');
    expect(result).toBe('trailing');
  });

  it('returns the exact slug when the literal hyphen-form already exists in DB', async () => {
    // If a brain has a page literally at slug `people-ben` (unlikely but
    // possible), the exact-slug step at the top of the chain returns it
    // before the rewrite step runs. This pins that ordering.
    await engine.putPage('people-literal-test', {
      type: 'person' as any,
      title: 'People Literal Test',
      compiled_truth: '# x',
      frontmatter: { type: 'person', title: 'People Literal Test', slug: 'people-literal-test' },
    }, { sourceId: 'default' });
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people-literal-test');
    expect(result).toBe('people-literal-test');
  });
});

describe('resolveEntitySlugWithSource — hyphen-prefix rewrite tagging', () => {
  it('tags hyphen-prefix rewrite as fuzzy_match (real-page resolution)', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'people-alice',
    );
    expect(result!.slug).toBe('people/alice-example');
    expect(result!.source).toBe<ResolutionSource>('fuzzy_match');
  });

  it('tags unknown-directory hyphen-prefix as fallback_slugify', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'data-claude-conventions',
    );
    expect(result!.slug).toBe('data-claude-conventions');
    expect(result!.source).toBe<ResolutionSource>('fallback_slugify');
  });

  it('tags unknown-directory comms- hyphen-prefix as fallback_slugify (workspace-l5o.36)', async () => {
    // Bead AC named `comms-` as a prefix to expand, but `comms/` isn't
    // a brain directory. Pin the fall-through so a future codex pass
    // can't reframe this as a bug. Tracked in workspace-l5o.36 for
    // extractor-side fix.
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'comms-eval-mjs',
    );
    expect(result!.slug).toBe('comms-eval-mjs');
    expect(result!.source).toBe<ResolutionSource>('fallback_slugify');
  });
});

// ─────────────────────────────────────────────────────────────────────
// workspace-i75 codex P2 — structural invariants
// ─────────────────────────────────────────────────────────────────────

describe('HYPHEN_PREFIX_REWRITE_SORTED — sort invariant', () => {
  it('sorts directories by descending length (greedy-longest-first)', () => {
    for (let i = 1; i < HYPHEN_PREFIX_REWRITE_SORTED.length; i++) {
      expect(HYPHEN_PREFIX_REWRITE_SORTED[i - 1].length).toBeGreaterThanOrEqual(
        HYPHEN_PREFIX_REWRITE_SORTED[i].length,
      );
    }
  });

  it('contains the known set of brain directories', () => {
    // Spot-check a few — full list is in resolve.ts. If a directory gets
    // added to /data/brain and warrants hyphen-prefix rewrite, also add
    // it to HYPHEN_PREFIX_REWRITE_DIRS.
    expect(HYPHEN_PREFIX_REWRITE_SORTED).toContain('people');
    expect(HYPHEN_PREFIX_REWRITE_SORTED).toContain('companies');
    expect(HYPHEN_PREFIX_REWRITE_SORTED).toContain('personal');
  });
});

describe('resolveEntitySlug — collision boundary (codex P2#3)', () => {
  it('rewrites "people-organizations" via expansion when no exact match exists', async () => {
    // Fixture: NO `people/organizations` page, but `people/organizations-foo`
    // does exist. Pins that when the exact-slug path misses, the
    // expansion path (people/organizations-%) is tried before giving up.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people-organizations');
    expect(result).toBe('people/organizations-foo');
  });

  it('rewrites a multi-hyphen rest via exact match on the slash form', async () => {
    // dir=personal, rest=reflections-foo → exact match on personal/reflections-foo.
    // This is the case that motivated the greedy-longest-first design:
    // if `personal-reflections/` ever becomes a registered dir, the sort
    // invariant guarantees `personal-reflections/foo` wins over
    // `personal/reflections-foo`. Today, only `personal/` is registered,
    // so the rewrite picks the exact `personal/reflections-foo`.
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'personal-reflections-foo');
    expect(result).toBe('personal/reflections-foo');
  });
});

// ─────────────────────────────────────────────────────────────────────
// workspace-i75 codex P2#2 — empirical-coverage regression fixture
// ─────────────────────────────────────────────────────────────────────
//
// Top-frequency unique slugs from ~/.gbrain/audit/stub-guard-2026-W21.jsonl
// captured at workspace-i75 fix time (166 lines / 24h on the cockpit).
// Each entry pins the expected resolution path:
//   - rewrite_hit: hyphen-prefix-rewrite finds a real page (test fixture has it)
//   - rewrite_miss: hyphen-prefix-rewrite tried but found nothing (falls through)
//   - fallback_slugify: no rewrite possible (dir not in HYPHEN_PREFIX_REWRITE_DIRS, or no hyphen)
//
// When the production resolver drifts, this list surfaces the regression.
// New top-frequency slugs from future audit log captures should be added
// (with their classification) as part of any change touching resolve.ts.
const AUDIT_LOG_FIXTURE: ReadonlyArray<{
  input: string;
  expected_path: 'rewrite_hit' | 'rewrite_miss' | 'fallback_slugify';
  expected_source: ResolutionSource;
}> = [
  // Top 5 hits from the W21 audit log
  { input: 'people-alice',            expected_path: 'rewrite_hit',      expected_source: 'fuzzy_match' },        // proxy for people-ben (43 hits) — fixture has alice-example
  { input: 'data-claude-conventions', expected_path: 'fallback_slugify', expected_source: 'fallback_slugify' },   // 14 hits — no data/ dir
  { input: 'comms-eval-mjs',          expected_path: 'fallback_slugify', expected_source: 'fallback_slugify' },   // 5 hits — no comms/ dir
  { input: 'companies-stripe',        expected_path: 'rewrite_hit',      expected_source: 'fuzzy_match' },        // proxy for companies-palantir (3) — fixture has stripe
  // Mid-frequency hits
  { input: 'evals-discovery',         expected_path: 'fallback_slugify', expected_source: 'fallback_slugify' },   // 3 hits — no evals/ dir
  { input: 'session-057491b8',        expected_path: 'rewrite_miss',     expected_source: 'fallback_slugify' },   // 2 hits — sessions/ would match but `session/` (singular) is NOT registered, and `session/` isn't in /data/brain anyway
  // Bare-slug cases (no hyphen-prefix-rewrite applicable)
  { input: 'brainops',                expected_path: 'fallback_slugify', expected_source: 'fallback_slugify' },   // bare slug, no hyphen
  { input: 'vanta',                   expected_path: 'fallback_slugify', expected_source: 'fallback_slugify' },   // bare slug, no hyphen
];

describe('resolveEntitySlug — empirical audit-log coverage (codex P2#2)', () => {
  for (const fixture of AUDIT_LOG_FIXTURE) {
    it(`pins resolution path for ${fixture.input} (${fixture.expected_path})`, async () => {
      const result = await resolveEntitySlugWithSource(
        engine as unknown as BrainEngine,
        'default',
        fixture.input,
      );
      expect(result).not.toBeNull();
      expect(result!.source).toBe<ResolutionSource>(fixture.expected_source);

      if (fixture.expected_path === 'fallback_slugify') {
        // Falls through to slugify — input unchanged (already lowercase-hyphen).
        expect(result!.slug).toBe(fixture.input);
      } else if (fixture.expected_path === 'rewrite_miss') {
        // Rewrite was attempted but found nothing; same slugify fall-through.
        expect(result!.slug).toBe(fixture.input);
      } else {
        // rewrite_hit: must contain a slash (real page slug shape).
        expect(result!.slug).toContain('/');
      }
    });
  }
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Alice Example')).toBe('alice-example');
  });

  it('handles single word', () => {
    expect(slugify('Alice')).toBe('alice');
  });

  it('strips accents', () => {
    expect(slugify('José García')).toBe('jose-garcia');
  });
});

// ─────────────────────────────────────────────────────────────────────
// v0.40.2.0 — resolveEntitySlugWithSource
// ─────────────────────────────────────────────────────────────────────
//
// Same resolution chain as resolveEntitySlug, but returns the source
// tag (`exact_page` | `fuzzy_match` | `fallback_slugify`) so trajectory
// routing in `gbrain think` (Commit 2) can gate on
// `resolution_source !== 'fallback_slugify'` and avoid querying invented
// slugs in production. The longmemeval harness accepts fallback_slugify
// because its extractor uses the same slugify fallback (they cohere).
//
// These tests pin the source-tag contract per branch.

describe('resolveEntitySlugWithSource — exact_page branch', () => {
  it('returns exact_page when raw is a full slug that exists', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'people/alice-example',
    );
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('people/alice-example');
    expect(result!.source).toBe<ResolutionSource>('exact_page');
  });

  it('returns exact_page when raw is a slug-shape match (lowercase, slash)', async () => {
    // Pre-existing companies/stripe is seeded; raw is exact.
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'companies/stripe',
    );
    expect(result!.slug).toBe('companies/stripe');
    expect(result!.source).toBe<ResolutionSource>('exact_page');
  });
});

describe('resolveEntitySlugWithSource — fuzzy_match branch', () => {
  it('returns fuzzy_match for a Title-cased display name', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'Alice Example',
    );
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('people/alice-example');
    expect(result!.source).toBe<ResolutionSource>('fuzzy_match');
  });

  it('returns fuzzy_match for prefix-expansion (bare first name "Alice")', async () => {
    // Bare name "Alice" doesn't exact-match any slug, fuzzy fails the
    // 0.4 threshold on short trigrams, so prefix expansion fires and
    // resolves to people/alice-example. We tag this branch as
    // fuzzy_match (not fallback_slugify) so trajectory routing knows
    // it's a real-page resolution.
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'Alice',
    );
    expect(result!.slug).toBe('people/alice-example');
    expect(result!.source).toBe<ResolutionSource>('fuzzy_match');
  });
});

describe('resolveEntitySlugWithSource — fallback_slugify branch', () => {
  it('returns fallback_slugify when no page matches', async () => {
    // "Zelda" isn't seeded; no exact, no fuzzy (no people/zelda-*),
    // prefix expansion finds nothing, falls through to slugify.
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'Zelda',
    );
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('zelda');
    expect(result!.source).toBe<ResolutionSource>('fallback_slugify');
  });

  it('returns fallback_slugify for multi-word non-match phrase', async () => {
    // "coffee maker" — common-noun phrase the trajectory router may
    // pull from question text. No page, no fuzzy hit (multi-word but
    // generic), no prefix expansion (multi-token rejects bare-name
    // heuristic), so slugify fires.
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'coffee maker',
    );
    expect(result!.slug).toBe('coffee-maker');
    expect(result!.source).toBe<ResolutionSource>('fallback_slugify');
  });

  it('returns fallback_slugify for accented input (slugify path strips)', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'José García',
    );
    expect(result!.slug).toBe('jose-garcia');
    expect(result!.source).toBe<ResolutionSource>('fallback_slugify');
  });
});

describe('resolveEntitySlugWithSource — null tail', () => {
  it('returns null for empty input', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      '',
    );
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only input', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      '   ',
    );
    expect(result).toBeNull();
  });
});

describe('resolveEntitySlugWithSource — back-compat with resolveEntitySlug', () => {
  it('exact_page branch matches resolveEntitySlug output (same slug, plus source tag)', async () => {
    const a = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people/alice-example');
    const b = await resolveEntitySlugWithSource(engine as unknown as BrainEngine, 'default', 'people/alice-example');
    expect(b!.slug).toBe(a!);
  });

  it('fallback_slugify branch matches resolveEntitySlug output (same slug, plus source tag)', async () => {
    const a = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Zelda');
    const b = await resolveEntitySlugWithSource(engine as unknown as BrainEngine, 'default', 'Zelda');
    expect(b!.slug).toBe(a!);
    expect(b!.source).toBe<ResolutionSource>('fallback_slugify');
  });
});
