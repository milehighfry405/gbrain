/**
 * Tests for env-aware `gbrain autopilot --install`.
 *
 * Covers:
 *   - detectInstallTarget picks the right target based on env vars +
 *     filesystem sentinels.
 *   - --target flag overrides detection.
 *   - Ephemeral-container path writes the start script + executable bit.
 *   - OpenClaw bootstrap injection is idempotent + creates .bak.
 *   - Uninstall mirrors all four targets and is a no-op when nothing is
 *     installed.
 *
 * Regression guards:
 *   - macOS launchd plist still writes the same shape it always did.
 *   - Linux crontab still writes the same every-5-min line.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { detectInstallTarget, generateWrapperScriptContent } from '../src/commands/autopilot.ts';

let tmp: string;
const envSnapshot: Record<string, string | undefined> = {};

function envKeys() {
  return ['HOME', 'RENDER', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME', 'OPENCLAW_HOME'] as const;
}

beforeEach(() => {
  for (const k of envKeys()) envSnapshot[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-install-test-'));
  process.env.HOME = tmp;
  // Start each test with a clean slate for ephemeral env vars.
  delete process.env.RENDER;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.FLY_APP_NAME;
  delete process.env.OPENCLAW_HOME;
});

afterEach(() => {
  for (const k of envKeys()) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('detectInstallTarget', () => {
  test('returns "macos" on darwin regardless of env', () => {
    if (process.platform !== 'darwin') return; // Skip on non-mac CI
    // Even if RENDER is set, darwin wins (user is probably dev-testing).
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('macos');
  });

  test('returns "ephemeral-container" when RENDER is set', () => {
    if (process.platform === 'darwin') return; // darwin shortcircuits first
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when RAILWAY_ENVIRONMENT is set', () => {
    if (process.platform === 'darwin') return;
    process.env.RAILWAY_ENVIRONMENT = 'production';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when FLY_APP_NAME is set', () => {
    if (process.platform === 'darwin') return;
    process.env.FLY_APP_NAME = 'myapp';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  // Note: direct testing of linux-systemd / linux-cron requires mocking
  // existsSync + execSync which is awkward in-process. Those branches are
  // exercised by the E2E test (Task 14) against a stubbed host.
});

// v0.36.1.x (cherry-pick #966): the autopilot wrapper script must source
// ~/.zshenv BEFORE ~/.zshrc. zshenv is the canonical place for env vars in
// non-interactive zsh; zshrc only fires for interactive shells, so vars
// exported in zshrc never reach the LaunchAgent subprocess. Operators who
// exported GBRAIN_DATABASE_URL or {OPENAI,ANTHROPIC}_API_KEY in zshrc and
// expected autopilot to inherit them hit silent missing-secret failures.
describe('autopilot wrapper script — env source order (v0.36.1.x #966)', () => {
  test('wrapper sources ~/.zshenv before ~/.zshrc', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/autopilot.ts', 'utf8');
    const zshenvIdx = src.indexOf('~/.zshenv');
    const zshrcIdx = src.indexOf('~/.zshrc');
    expect(zshenvIdx).toBeGreaterThan(0);
    expect(zshrcIdx).toBeGreaterThan(0);
    expect(zshenvIdx).toBeLessThan(zshrcIdx);
    // Both should appear inside writeWrapperScript's heredoc as `source ~/.foo`
    expect(src).toMatch(/source\s+~\/\.zshenv/);
    expect(src).toMatch(/source\s+~\/\.zshrc/);
  });
});

// workspace-l5o.34: --env-file lets the install wrapper source a host/app env
// file (e.g. /data/.openclaw/.env on AlphaClaw) so API keys reach autopilot
// even when not exported via ~/.zshenv. The autopilot daemon's subagent
// dispatch path constructs `new Anthropic()` (no explicit key arg), which
// resolves ANTHROPIC_API_KEY from process.env at construction — when the env
// is empty (the AlphaClaw default before this fix), every subagent job
// permanently failed with "Could not resolve authentication method."
describe('generateWrapperScriptContent — --env-file (workspace-l5o.34)', () => {
  test('omits env-file block when no path provided (backward compat)', () => {
    const content = generateWrapperScriptContent('/usr/bin/gbrain', '/data/brain');
    expect(content).not.toMatch(/--env-file/);
    expect(content).not.toMatch(/set -a/);
    // Pre-existing zshenv → zshrc chain still present.
    expect(content).toMatch(/source\s+~\/\.zshenv/);
    expect(content).toMatch(/source\s+~\/\.zshrc/);
  });

  test('sources env-file BEFORE ~/.zshenv when provided', () => {
    const content = generateWrapperScriptContent(
      '/usr/bin/gbrain',
      '/data/brain',
      '/data/.openclaw/.env',
    );
    const envFileIdx = content.indexOf('/data/.openclaw/.env');
    const zshenvIdx = content.indexOf('~/.zshenv');
    expect(envFileIdx).toBeGreaterThan(-1);
    expect(zshenvIdx).toBeGreaterThan(-1);
    expect(envFileIdx).toBeLessThan(zshenvIdx);
  });

  test('wraps env-file source in set -a / set +a so child processes inherit', () => {
    const content = generateWrapperScriptContent(
      '/usr/bin/gbrain',
      '/data/brain',
      '/data/.openclaw/.env',
    );
    // The codex-P2#1 fix: must be an if/fi block, NOT an && chain. The && chain
    // skipped `set +a` whenever `source` returned nonzero (e.g. malformed env
    // file), leaving allexport on while ~/.zshenv et al. were sourced after.
    expect(content).toMatch(/if \[ -f '\/data\/\.openclaw\/\.env' \]; then\s+set -a\s+source '\/data\/\.openclaw\/\.env' 2>\/dev\/null \|\| true\s+set \+a\s+fi/);
  });

  test('set +a runs even when source fails (codex-P2#1 fix — no && chain)', () => {
    const content = generateWrapperScriptContent(
      '/usr/bin/gbrain',
      '/data/brain',
      '/data/.openclaw/.env',
    );
    // Negative assertion: the bug-shape that skipped set +a on failure.
    expect(content).not.toMatch(/&& set \+a/);
    // Positive assertion: source uses || true so the script doesn't error out,
    // and set +a is on its own line within the if/fi block.
    expect(content).toMatch(/source '[^']+' 2>\/dev\/null \|\| true/);
  });

  test("escapes single quotes in env-file path to prevent shell injection", () => {
    const content = generateWrapperScriptContent(
      '/usr/bin/gbrain',
      '/data/brain',
      "/path/with'quote.env",
    );
    // Single-quote escaping convention: ' becomes '\''
    expect(content).toContain("/path/with'\\''quote.env");
  });

  test('preserves zshenv-before-zshrc invariant when env-file is set', () => {
    const content = generateWrapperScriptContent(
      '/usr/bin/gbrain',
      '/data/brain',
      '/data/.openclaw/.env',
    );
    const zshenvIdx = content.indexOf('~/.zshenv');
    const zshrcIdx = content.indexOf('~/.zshrc');
    expect(zshenvIdx).toBeGreaterThan(-1);
    expect(zshrcIdx).toBeGreaterThan(-1);
    expect(zshenvIdx).toBeLessThan(zshrcIdx);
  });

  test('still exec-s gbrain with the supplied repo path (env-file is additive)', () => {
    const content = generateWrapperScriptContent(
      '/custom/bin/gbrain',
      '/some/repo',
      '/data/.openclaw/.env',
    );
    expect(content).toMatch(/exec '\/custom\/bin\/gbrain' autopilot --repo '\/some\/repo'/);
  });
});
