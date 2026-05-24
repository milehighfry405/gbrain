import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  autoFixFrontmatter,
  writeBrainPage,
  scanBrainSources,
  BrainWriterError,
} from '../src/core/brain-writer.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const fence = '---';

describe('autoFixFrontmatter', () => {
  test('strips null bytes', () => {
    const input = `${fence}\ntitle: ok\n${fence}\n\nbody\x00drop\x00here`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(content.includes('\x00')).toBe(false);
    expect(fixes.some(f => f.code === 'NULL_BYTES')).toBe(true);
  });

  test('inserts closing --- before heading when MISSING_CLOSE', () => {
    const input = `${fence}\ntype: concept\ntitle: ok\n# A heading\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(fixes.some(f => f.code === 'MISSING_CLOSE')).toBe(true);
    // After fix, parsing should find a closing --- before the heading.
    const idxClose = content.indexOf('---', 3);
    const idxHeading = content.indexOf('# A heading');
    expect(idxClose).toBeGreaterThan(0);
    expect(idxClose).toBeLessThan(idxHeading);
  });

  test('rewrites nested-quote title to single-quoted', () => {
    const input = `${fence}\ntype: concept\ntitle: "Phil "Nick" Last"\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(fixes.some(f => f.code === 'NESTED_QUOTES')).toBe(true);
    // Outer wrapper is now single quotes.
    expect(content).toMatch(/^title: '.*'\s*$/m);
  });

  test('removes mismatched slug field', () => {
    const input = `${fence}\ntype: concept\ntitle: hi\nslug: wrong-slug\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input, { filePath: 'people/jane-doe.md' });
    expect(fixes.some(f => f.code === 'SLUG_MISMATCH')).toBe(true);
    expect(content).not.toMatch(/^slug:/m);
  });

  test('idempotent: running twice produces no diff and no fixes on second pass', () => {
    const input = `${fence}\ntype: concept\ntitle: "Phil "Nick" Last"\n${fence}\n\nbody\x00`;
    const first = autoFixFrontmatter(input);
    const second = autoFixFrontmatter(first.content);
    expect(second.content).toBe(first.content);
    expect(second.fixes).toEqual([]);
  });

  test('clean input: no fixes, content unchanged', () => {
    const input = `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(content).toBe(input);
    expect(fixes).toEqual([]);
  });

  // v0.37.9.0 — Step 3a canonical-style normalization for tags/aliases arrays.
  // The validator post-v0.37.5.0 no longer flags `tags: ["yc"]` as broken,
  // but this pass still rewrites it for consistency with serializeFrontmatter.
  test('step 3a: normalizes JSON-style double-quoted tags to single-quoted', () => {
    const input = `${fence}\ntype: person\ntags: ["yc", "w2025"]\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(fixes.some(f => f.code === 'NESTED_QUOTES')).toBe(true);
    expect(content).toContain("tags: ['yc', 'w2025']");
    expect(content).not.toContain('tags: ["yc", "w2025"]');
  });

  test('step 3a: apostrophe in item falls back to double quotes', () => {
    const input = `${fence}\ntype: person\ntags: ["Men's Fashion", "yc"]\n${fence}\n\nbody`;
    const { content } = autoFixFrontmatter(input);
    // Apostrophe item keeps double quotes; clean item uses single.
    expect(content).toContain(`tags: ["Men's Fashion", 'yc']`);
  });

  test('step 3a: empty item handled as empty single-quoted scalar', () => {
    const input = `${fence}\ntype: person\ntags: ["", "yc"]\n${fence}\n\nbody`;
    const { content } = autoFixFrontmatter(input);
    expect(content).toContain(`tags: ['', 'yc']`);
  });

  test('step 3a: non-allow-listed keys untouched (metrics, scores, etc.)', () => {
    const input = `${fence}\ntype: company\nmetrics: ["1", "2", "3"]\nscores: ["a", "b"]\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    // Only `tags` and `aliases` are in the allow-list.
    expect(content).toContain('metrics: ["1", "2", "3"]');
    expect(content).toContain('scores: ["a", "b"]');
    expect(fixes.some(f => f.code === 'NESTED_QUOTES')).toBe(false);
  });

  test('step 3a applies to aliases: key as well as tags:', () => {
    const input = `${fence}\ntype: person\naliases: ["Bob", "Robert"]\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(fixes.some(f => f.code === 'NESTED_QUOTES')).toBe(true);
    expect(content).toContain("aliases: ['Bob', 'Robert']");
  });

  // codex outside-voice review (D7-2): when step 3a AND step 3 both fire on
  // the same file, the audit must record ONE NESTED_QUOTES entry, not two.
  // Otherwise frontmatter_integrity counts double-rewrites as two separate
  // files needing repair.
  test('step 3a + step 3 dedup: one NESTED_QUOTES fix record per file', () => {
    const input = `${fence}\ntype: person\ntitle: "Phil "Nick" Last"\ntags: ["yc", "w2025"]\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    const nestedQuotesFixes = fixes.filter(f => f.code === 'NESTED_QUOTES');
    expect(nestedQuotesFixes.length).toBe(1);
    // Both rewrites applied to the content.
    expect(content).toContain("tags: ['yc', 'w2025']");
    expect(content).toMatch(/^title: '.*'\s*$/m);
  });

  test('step 3a: idempotent (running twice on already-normalized leaves content unchanged)', () => {
    const input = `${fence}\ntype: person\ntags: ['yc', 'w2025']\n${fence}\n\nbody`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(content).toBe(input);
    expect(fixes).toEqual([]);
  });
});

describe('writeBrainPage', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-writer-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('happy path: writes file inside source', () => {
    const file = join(tmp, 'people', 'jane.md');
    const content = `${fence}\ntype: person\ntitle: Jane\n${fence}\n\nhello`;
    writeBrainPage(file, content, { sourcePath: tmp });
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  test('throws BrainWriterError when path is outside sourcePath', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'brain-writer-other-'));
    try {
      const offending = join(elsewhere, 'evil.md');
      expect(() =>
        writeBrainPage(offending, 'content', { sourcePath: tmp }),
      ).toThrow(BrainWriterError);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('writes a centralized .bak before mutating an existing file', () => {
    // v0.36.x #902: backups land under ~/.gbrain/backups/frontmatter/... not
    // next to the source file (pre-fix littered the brain tree with .bak
    // files that broke gitignore expectations). The returned backupPath is
    // the contract — the test asserts both the path shape and that the
    // backup faithfully captures the pre-write content.
    const file = join(tmp, 'people', 'jane.md');
    mkdirSync(join(tmp, 'people'), { recursive: true });
    const original = `${fence}\ntype: person\ntitle: Old\n${fence}\n\nold`;
    writeFileSync(file, original);
    const backupRoot = mkdtempSync(join(tmpdir(), 'gbrain-test-backups-'));
    try {
      const { backupPath } = writeBrainPage(
        file,
        `${fence}\ntype: person\ntitle: New\n${fence}\n\nnew`,
        { sourcePath: tmp, backupRoot },
      );
      expect(backupPath).toBeDefined();
      // Centralized — under the test-injected backupRoot, NOT a sibling .bak.
      expect(existsSync(file + '.bak')).toBe(false);
      expect(backupPath!.startsWith(backupRoot + '/')).toBe(true);
      expect(backupPath!.endsWith('.bak')).toBe(true);
      expect(existsSync(backupPath!)).toBe(true);
      expect(readFileSync(backupPath!, 'utf8')).toBe(original);
    } finally {
      rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  test('autoFix: true repairs nested quotes before writing', () => {
    const file = join(tmp, 'people', 'jane.md');
    const broken = `${fence}\ntype: person\ntitle: "Phil "Nick" Last"\n${fence}\n\nbody`;
    const { fixes } = writeBrainPage(file, broken, { sourcePath: tmp, autoFix: true });
    expect(fixes.some(f => f.code === 'NESTED_QUOTES')).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/^title: '.*'\s*$/m);
  });
});

describe('scanBrainSources (PGLite)', () => {
  let tmp: string;
  let engine: PGLiteEngine;

  // One PGLite per file — beforeEach wipes data only. PGLite cold-start is
  // ~20s on CI; sharing one engine across 6 tests in this block saves ~2 min.
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
    tmp = mkdtempSync(join(tmpdir(), 'brain-writer-scan-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function registerSource(id: string, path: string) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      [id, path],
    );
  }

  test('returns ok=true for empty source', async () => {
    await registerSource('empty', tmp);
    const report = await scanBrainSources(engine);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(0);
    const empty = report.per_source.find(s => s.source_id === 'empty');
    expect(empty).toBeDefined();
    expect(empty!.total).toBe(0);
  });

  test('detects errors across multiple sources', async () => {
    const srcA = join(tmp, 'a');
    const srcB = join(tmp, 'b');
    mkdirSync(srcA, { recursive: true });
    mkdirSync(srcB, { recursive: true });
    writeFileSync(join(srcA, 'p1.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody\x00`);
    writeFileSync(join(srcB, 'p2.md'), `${fence}\ntype: x\ntitle: "P "I" L"\n${fence}\n\nbody`);
    await registerSource('alpha', srcA);
    await registerSource('beta', srcB);

    const report = await scanBrainSources(engine);
    expect(report.ok).toBe(false);
    expect(report.total).toBeGreaterThan(0);
    const alpha = report.per_source.find(s => s.source_id === 'alpha')!;
    const beta = report.per_source.find(s => s.source_id === 'beta')!;
    expect(alpha.errors_by_code.NULL_BYTES).toBeGreaterThanOrEqual(1);
    expect(beta.errors_by_code.NESTED_QUOTES).toBeGreaterThanOrEqual(1);
  });

  test('respects sourceId filter', async () => {
    const srcA = join(tmp, 'a');
    const srcB = join(tmp, 'b');
    mkdirSync(srcA, { recursive: true });
    mkdirSync(srcB, { recursive: true });
    writeFileSync(join(srcA, 'bad.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody\x00`);
    writeFileSync(join(srcB, 'bad.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody\x00`);
    await registerSource('alpha', srcA);
    await registerSource('beta', srcB);

    const onlyA = await scanBrainSources(engine, { sourceId: 'alpha' });
    expect(onlyA.per_source.length).toBe(1);
    expect(onlyA.per_source[0]!.source_id).toBe('alpha');
  });

  test('skips registered source with missing path', async () => {
    await registerSource('ghost', join(tmp, 'does-not-exist'));
    const report = await scanBrainSources(engine);
    const ghost = report.per_source.find(s => s.source_id === 'ghost')!;
    expect(ghost.total).toBe(0);
  });

  test('skips symlinks (matches sync no-symlink policy)', async () => {
    mkdirSync(join(tmp, 'real'), { recursive: true });
    writeFileSync(join(tmp, 'real', 'good.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody`);
    // Create a symlink loop: tmp/real/loop -> tmp/real
    try {
      symlinkSync(join(tmp, 'real'), join(tmp, 'real', 'loop'));
    } catch {
      // Some CI environments forbid symlink creation; skip the assertion.
      return;
    }
    await registerSource('with-symlink', tmp);
    const report = await scanBrainSources(engine);
    // The walk should complete without infinite-looping; at most one .md
    // entry visited (via the real path, not the symlink).
    expect(report.per_source[0]!.total).toBe(0);
  });

  // workspace-icm4 — pre-fix the gstack source ignored 50/52 (96%) of files
  // for MISSING_OPEN and still returned ok=true with no other trace. Fix: a
  // warn-level signal at high ignored ratio that blocks ok=true and surfaces
  // in report.warnings.
  describe('workspace-icm4: high ignored MISSING_OPEN ratio surfaces a warning', () => {
    test('source with 96% missing frontmatter: warning + ok=false', async () => {
      const src = join(tmp, 'high-ignore');
      mkdirSync(src, { recursive: true });
      for (let i = 0; i < 48; i++) {
        writeFileSync(join(src, `bare${i}.md`), `# Bare title\n\nbody`);
      }
      writeFileSync(join(src, 'good1.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody`);
      writeFileSync(join(src, 'good2.md'), `${fence}\ntype: x\ntitle: ok\n${fence}\n\nbody`);
      await registerSource('high-ignore', src);
      const report = await scanBrainSources(engine);
      expect(report.ok).toBe(false);
      expect(report.total).toBe(0);
      expect(report.warnings.length).toBe(1);
      const w = report.warnings[0];
      expect(w.code).toBe('HIGH_IGNORED_MISSING_OPEN_RATIO');
      expect(w.source_id).toBe('high-ignore');
      expect(w.ignored).toBe(48);
      expect(w.files_scanned).toBe(50);
      expect(w.ratio).toBeGreaterThan(0.9);
    });

    test('source with all frontmatter: no warning, ok=true', async () => {
      const src = join(tmp, 'all-good');
      mkdirSync(src, { recursive: true });
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(src, `p${i}.md`), `${fence}\ntype: x\ntitle: t${i}\n${fence}\n\nbody`);
      }
      await registerSource('all-good', src);
      const report = await scanBrainSources(engine);
      expect(report.ok).toBe(true);
      expect(report.warnings).toEqual([]);
    });

    test('source with low ignored ratio (10%): no warning, ok=true', async () => {
      const src = join(tmp, 'low-ignore');
      mkdirSync(src, { recursive: true });
      for (let i = 0; i < 9; i++) {
        writeFileSync(join(src, `p${i}.md`), `${fence}\ntype: x\ntitle: t${i}\n${fence}\n\nbody`);
      }
      writeFileSync(join(src, 'bare.md'), `# Bare\n\nbody`);
      await registerSource('low-ignore', src);
      const report = await scanBrainSources(engine);
      expect(report.ok).toBe(true);
      expect(report.warnings).toEqual([]);
    });

    test('tiny source (2 files all bare): no warning despite 100% ratio (below min-files floor)', async () => {
      const src = join(tmp, 'tiny');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'a.md'), `# A\n\nbody`);
      writeFileSync(join(src, 'b.md'), `# B\n\nbody`);
      await registerSource('tiny', src);
      const report = await scanBrainSources(engine);
      // 2 files < min-files floor (4) → ratio not gated even though it's 100%.
      // Keeps the warning from firing on accidentally-empty trees.
      expect(report.warnings).toEqual([]);
      expect(report.ok).toBe(true);
    });

    test('ratio exactly at threshold (25% of 8 files): warning fires (boundary inclusive)', async () => {
      const src = join(tmp, 'boundary');
      mkdirSync(src, { recursive: true });
      // 2 bare / 6 frontmatter / total 8 → 25% ignored ratio exactly.
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(src, `p${i}.md`), `${fence}\ntype: x\ntitle: t${i}\n${fence}\n\nbody`);
      }
      writeFileSync(join(src, 'bare1.md'), `# Bare\n\nbody`);
      writeFileSync(join(src, 'bare2.md'), `# Bare\n\nbody`);
      await registerSource('boundary', src);
      const report = await scanBrainSources(engine);
      expect(report.warnings.length).toBe(1);
      expect(report.warnings[0].source_id).toBe('boundary');
      expect(report.warnings[0].ratio).toBeCloseTo(0.25, 5);
    });

    test('threshold=0 with clean source (ignored=0): no warning (codex P2 #2)', async () => {
      const src = join(tmp, 'clean-zero-threshold');
      mkdirSync(src, { recursive: true });
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(src, `p${i}.md`), `${fence}\ntype: x\ntitle: t${i}\n${fence}\n\nbody`);
      }
      await registerSource('clean-zero-threshold', src);
      const original = process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN;
      try {
        // threshold=0 means "warn on any ignored file" — but a source with
        // zero ignored files must NOT warn. Pre-P2-fix the comparison
        // `ratio < threshold` was false for `0 < 0`, so the warning fired.
        process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN = '0';
        const report = await scanBrainSources(engine);
        expect(report.warnings).toEqual([]);
        expect(report.ok).toBe(true);
      } finally {
        if (original === undefined) delete process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN;
        else process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN = original;
      }
    });

    test('multi-source: only the high-ratio source surfaces; the clean source is silent', async () => {
      const dirty = join(tmp, 'dirty');
      const clean = join(tmp, 'clean');
      mkdirSync(dirty, { recursive: true });
      mkdirSync(clean, { recursive: true });
      for (let i = 0; i < 8; i++) {
        writeFileSync(join(dirty, `bare${i}.md`), `# Bare\n\nbody`);
      }
      for (let i = 0; i < 8; i++) {
        writeFileSync(join(clean, `p${i}.md`), `${fence}\ntype: x\ntitle: t${i}\n${fence}\n\nbody`);
      }
      await registerSource('dirty', dirty);
      await registerSource('clean', clean);
      const report = await scanBrainSources(engine);
      expect(report.warnings.length).toBe(1);
      expect(report.warnings[0].source_id).toBe('dirty');
      // Clean source must not appear anywhere in warnings.
      expect(report.warnings.find(w => w.source_id === 'clean')).toBeUndefined();
      expect(report.ok).toBe(false);
    });

    test('GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN: partially-invalid string falls back to default (codex P2 #3)', async () => {
      const src = join(tmp, 'parse-strict');
      mkdirSync(src, { recursive: true });
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(src, `bare${i}.md`), `# Bare\n\nbody`);
      }
      await registerSource('parse-strict', src);
      const original = process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN;
      try {
        // parseFloat('1.5abc') → 1.5 (silently coerces); Number('1.5abc') → NaN.
        // Predictable config parsing means we reject this and use the default.
        process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN = '1.5abc';
        const report = await scanBrainSources(engine);
        // Default 0.25 applies → 100% ratio > 0.25 → warning fires.
        // Pre-P2-fix: parseFloat would accept 1.5, suppress the warning,
        // and silently mask the high ratio.
        expect(report.warnings.length).toBe(1);
      } finally {
        if (original === undefined) delete process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN;
        else process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN = original;
      }
    });

    test('GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN overrides the default threshold', async () => {
      const src = join(tmp, 'tunable');
      mkdirSync(src, { recursive: true });
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(src, `bare${i}.md`), `# Bare\n\nbody`);
      }
      await registerSource('tunable', src);
      const original = process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN;
      try {
        // Raise threshold above the actual ratio (sentinel >1) → warning suppressed.
        process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN = '1.5';
        const acknowledged = await scanBrainSources(engine);
        expect(acknowledged.warnings).toEqual([]);
        expect(acknowledged.ok).toBe(true);

        // Invalid env value falls back to default (0.25) → warning fires again.
        process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN = 'not-a-number';
        const fallback = await scanBrainSources(engine);
        expect(fallback.warnings.length).toBe(1);
      } finally {
        if (original === undefined) delete process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN;
        else process.env.GBRAIN_FRONTMATTER_IGNORED_RATIO_WARN = original;
      }
    });
  });

  test('AbortSignal before scan: every source marked skipped (v0.38.2.0 partial-state contract)', async () => {
    const src = join(tmp, 'big');
    mkdirSync(src, { recursive: true });
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(src, `p${i}.md`), `${fence}\ntype: x\ntitle: t${i}\n${fence}\n\nbody`);
    }
    await registerSource('big', src);
    const ctrl = new AbortController();
    ctrl.abort();
    const report = await scanBrainSources(engine, { signal: ctrl.signal });
    // v0.38.2.0 changed the contract: instead of an empty per_source array
    // (which hid the fact that sources weren't checked), the report now
    // includes a 'skipped' entry per source the outer loop never reached.
    // Doctor renders these as "NOT SCANNED" so the user knows.
    expect(report.per_source.length).toBe(1);
    expect(report.per_source[0].status).toBe('skipped');
    expect(report.per_source[0].files_scanned).toBe(0);
    expect(report.partial).toBe(true);
    expect(report.ok).toBe(false);
  });
});
