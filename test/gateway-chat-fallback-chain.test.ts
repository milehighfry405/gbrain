/**
 * workspace-l5o.23 Half B — chat_fallback_chain retry logic.
 *
 * Pins the opt-in provider-fallback behavior wired into gateway.chat():
 *   (a) Retry-worthy 5xx (AITransientError) falls through to next provider.
 *   (b) Retry-worthy network/timeout/429 falls through.
 *   (c) 4xx auth / model_not_found (AIConfigError) does NOT fall through.
 *   (d) Budget tracker records BOTH failed primary AND successful fallback.
 *   (e) ChatResult.model reports the model that actually answered.
 *   (f) Empty/unset chat_fallback_chain = legacy single-attempt behavior.
 *
 * Hermetic: uses the chat-transport test seam (`__setChatTransportForTests`)
 * so no API key + no network. Budget tracker writes to a tmpdir JSONL.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __setChatTransportForTests,
  chat,
  configureGateway,
  resetGateway,
  withBudgetTracker,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { AIConfigError, AITransientError } from '../src/core/ai/errors.ts';

let tmp: string;
let auditPath: string;

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-fallback-test-'));
  auditPath = join(tmp, 'budget.jsonl');
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  rmSync(tmp, { recursive: true, force: true });
});

function readAudit(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function makeOpts(model?: string): ChatOpts {
  return {
    model,
    system: 'sys',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 100,
  };
}

function successResult(model: string): ChatResult {
  return {
    text: 'ok',
    blocks: [{ type: 'text', text: 'ok' }],
    stopReason: 'end',
    usage: {
      input_tokens: 50,
      output_tokens: 25,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model,
    providerId: model.split(':')[0] ?? model,
  };
}

describe('chat_fallback_chain — retry-worthy errors fall through', () => {
  test('5xx (AITransientError) on primary falls through to next in chain', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-openai-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? 'unknown');
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        throw new AITransientError('upstream 503 Service Unavailable');
      }
      return successResult('openai:gpt-5');
    });

    const res = await chat(makeOpts());
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-5']);
    expect(res.model).toBe('openai:gpt-5');
    expect(res.text).toBe('ok');
  });

  test('network/timeout error (status 502) falls through to next provider', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['google:gemini-2.5-pro'],
      env: { ANTHROPIC_API_KEY: 'sk-x', GOOGLE_GENERATIVE_AI_API_KEY: 'g-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? 'unknown');
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        // Mirrors AI SDK error shape for upstream 5xx — has a numeric
        // `status`, so the provider-shaped whitelist normalizes to
        // AITransientError and triggers fallback.
        const err: Error & { status?: number } = new Error('Bad Gateway');
        err.status = 502;
        throw err;
      }
      return successResult('google:gemini-2.5-pro');
    });

    const res = await chat(makeOpts());
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6', 'google:gemini-2.5-pro']);
    expect(res.model).toBe('google:gemini-2.5-pro');
  });

  test('429 rate_limit (AITransientError) falls through', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    __setChatTransportForTests(async (opts) => {
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        // Mirrors AI SDK's shape: status 429 → normalizeAIError → AITransientError
        const err: Error & { status?: number } = new Error('rate limit exceeded');
        err.status = 429;
        throw err;
      }
      return successResult('openai:gpt-5');
    });

    const res = await chat(makeOpts());
    expect(res.model).toBe('openai:gpt-5');
  });

  test('walks the full chain when each prior attempt is transient', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5', 'google:gemini-2.5-pro'],
      env: {
        ANTHROPIC_API_KEY: 'a',
        OPENAI_API_KEY: 'o',
        GOOGLE_GENERATIVE_AI_API_KEY: 'g',
      },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? '');
      if (opts.model === 'google:gemini-2.5-pro') return successResult('google:gemini-2.5-pro');
      throw new AITransientError('boom');
    });

    const res = await chat(makeOpts());
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-5', 'google:gemini-2.5-pro']);
    expect(res.model).toBe('google:gemini-2.5-pro');
  });
});

describe('chat_fallback_chain — non-retry errors do NOT fall through', () => {
  test('4xx auth (AIConfigError) on primary surfaces immediately, no fallback', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'bad', OPENAI_API_KEY: 'sk-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? '');
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        throw new AIConfigError('401 invalid API key', 'check your key');
      }
      return successResult('openai:gpt-5');
    });

    let caught: unknown = null;
    try {
      await chat(makeOpts());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIConfigError);
    // Fallback must NOT have been tried — config bugs shouldn't be masked.
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6']);
  });

  test('model_not_found (404 → AIConfigError) does NOT fall through', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? '');
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        const err: Error & { status?: number } = new Error('model not found');
        err.status = 404;
        throw err;
      }
      return successResult('openai:gpt-5');
    });

    let caught: unknown = null;
    try {
      await chat(makeOpts());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIConfigError);
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6']);
  });
});

describe('chat_fallback_chain — opt-in semantics', () => {
  test('unset chat_fallback_chain = legacy single-attempt behavior (no retry)', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'sk-x' },
    });

    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      throw new AITransientError('upstream 503');
    });

    let caught: unknown = null;
    try {
      await chat(makeOpts());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AITransientError);
    expect(calls).toBe(1);
  });

  test('empty chat_fallback_chain = legacy single-attempt behavior (no retry)', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: [],
      env: { ANTHROPIC_API_KEY: 'sk-x' },
    });

    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      throw new AITransientError('upstream 503');
    });

    let caught: unknown = null;
    try {
      await chat(makeOpts());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AITransientError);
    expect(calls).toBe(1);
  });

  test('all attempts exhausted on transient errors surfaces last error', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? '');
      throw new AITransientError(`fail on ${opts.model}`);
    });

    let caught: unknown = null;
    try {
      await chat(makeOpts());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AITransientError);
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-5']);
    expect((caught as Error).message).toContain('openai:gpt-5');
  });

  test('duplicate primary in chain is skipped (no double-attempt of same model)', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['anthropic:claude-sonnet-4-6', 'openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? '');
      if (opts.model === 'openai:gpt-5') return successResult('openai:gpt-5');
      throw new AITransientError('boom');
    });

    const res = await chat(makeOpts());
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-5']);
    expect(res.model).toBe('openai:gpt-5');
  });

  test('dedupe is EXACT-STRING only — provider-prefixed and bare alias attempt twice', async () => {
    // Pins the current contract (P2 advisory from codex review of l5o.23):
    // attempts.includes() is an exact-string compare, so the same underlying
    // model expressed two different ways (e.g. one bare alias, one fully
    // qualified provider:model) is NOT deduped. If you want alias-aware
    // dedupe, that's resolveChatProvider-level work — file a follow-up bead
    // when a real user trips on it, don't pre-build it here.
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      // 'claude-sonnet-4-6' (bare) and 'anthropic:claude-sonnet-4-6'
      // (prefixed) resolve to the same provider/model in production, but as
      // strings they differ. Test transport sees them as distinct.
      chat_fallback_chain: ['claude-sonnet-4-6', 'openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? '');
      if (opts.model === 'openai:gpt-5') return successResult('openai:gpt-5');
      throw new AITransientError('boom');
    });

    const res = await chat(makeOpts());
    // Both string forms attempted (exact-string semantics), then openai
    // succeeds. If a future change adds alias-aware dedupe, this test
    // breaks loudly + the reader sees the contract change in the diff.
    expect(seen).toEqual([
      'anthropic:claude-sonnet-4-6',
      'claude-sonnet-4-6',
      'openai:gpt-5',
    ]);
    expect(res.model).toBe('openai:gpt-5');
  });
});

describe('chat_fallback_chain — programmer errors are not retryable', () => {
  test('TypeError from a test transport propagates as TypeError (no fallback)', async () => {
    // P2 advisory from codex review: errors that aren't provider/SDK shaped
    // (no status, no known AI SDK error name, not AIServiceError) must NOT
    // be silently normalized into AITransientError — that would convert a
    // genuine test bug into a fallback that obscures the failure. Pin the
    // pass-through contract.
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? '');
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        throw new TypeError("Cannot read properties of undefined (reading 'foo')");
      }
      return successResult('openai:gpt-5');
    });

    let caught: unknown = null;
    try {
      await chat(makeOpts());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('Cannot read properties');
    // Fallback MUST NOT have fired — the test bug stays visible.
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6']);
  });

  test('plain Error without status propagates unchanged (no fallback)', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? '');
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        throw new Error('assertion failed: expected x to be y');
      }
      return successResult('openai:gpt-5');
    });

    let caught: unknown = null;
    try {
      await chat(makeOpts());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AITransientError);
    expect((caught as Error).message).toContain('assertion failed');
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6']);
  });

  test('Error with status:500 IS normalized + IS retried (provider-shaped)', async () => {
    // Counter-pin: the whitelist must still admit SDK-shaped errors. A raw
    // Error carrying a numeric `status` (the shape AI SDK gives us on 5xx)
    // gets normalized → AITransientError → fallback fires.
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    __setChatTransportForTests(async (opts) => {
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        const err: Error & { status?: number } = new Error('Internal Server Error');
        err.status = 500;
        throw err;
      }
      return successResult('openai:gpt-5');
    });

    const res = await chat(makeOpts());
    expect(res.model).toBe('openai:gpt-5');
  });
});

describe('chat_fallback_chain — budget tracker bookkeeping', () => {
  test('budget tracker records BOTH failed primary AND successful fallback', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['anthropic:claude-haiku-4-5-20251001'],
      env: { ANTHROPIC_API_KEY: 'sk-x' },
    });

    __setChatTransportForTests(async (opts) => {
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        throw new AITransientError('upstream 503');
      }
      return successResult('anthropic:claude-haiku-4-5-20251001');
    });

    const tracker = new BudgetTracker({ maxCostUsd: 1.0, label: 'fallback-test', auditPath });
    const res = await withBudgetTracker(tracker, () => chat(makeOpts()));
    expect(res.model).toBe('anthropic:claude-haiku-4-5-20251001');

    const audit = readAudit();
    // Expect at least 4 entries: reserve+record for primary (failed) and
    // reserve+record for fallback (succeeded).
    const reserves = audit.filter((e) => e.event === 'reserve' || e.event === 'reserve_unpriced');
    const records = audit.filter((e) => e.event === 'record' || e.event === 'record_unpriced');
    expect(reserves.length).toBe(2);
    expect(records.length).toBe(2);

    const reservedModels = reserves.map((e) => e.model);
    expect(reservedModels).toEqual([
      'anthropic:claude-sonnet-4-6',
      'anthropic:claude-haiku-4-5-20251001',
    ]);
    const recordedModels = records.map((e) => e.model);
    // Primary recorded under requested model (no provider answered); fallback
    // recorded under the answering model from ChatResult.model.
    expect(recordedModels).toContain('anthropic:claude-sonnet-4-6');
    expect(recordedModels).toContain('anthropic:claude-haiku-4-5-20251001');
  });
});

describe('chat_fallback_chain — reserve/record symmetry on production-path failure', () => {
  test('resolveChatProvider failure after reserve still records (no leaked reservation)', async () => {
    // P2 advisory from codex review of l5o.23: when resolveChatProvider
    // throws AFTER reserve() but BEFORE the inner try/catch could fire (e.g.
    // missing API key, unknown model alias), the outer try/finally in
    // _chatOnce must still record a pessimistic-fallback usage so the
    // reservation isn't orphaned in the budget tracker's audit log.
    //
    // No test transport here — we exercise the real production path with a
    // config that's guaranteed to fail at instantiateChat() (missing
    // ANTHROPIC_API_KEY).
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: {}, // no API key → instantiateChat throws AIConfigError
    });
    __setChatTransportForTests(null);

    const tracker = new BudgetTracker({ maxCostUsd: 1.0, label: 'symmetry-test', auditPath });

    let caught: unknown = null;
    try {
      await withBudgetTracker(tracker, () => chat(makeOpts()));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIConfigError);

    const audit = readAudit();
    const reserves = audit.filter((e) => e.event === 'reserve' || e.event === 'reserve_unpriced');
    const records = audit.filter((e) => e.event === 'record' || e.event === 'record_unpriced');
    // Reserve + record must pair up — even when the provider-resolution step
    // threw before the per-call try/catch. One reserve, one record.
    expect(reserves.length).toBe(1);
    expect(records.length).toBe(1);
    expect(reserves[0].model).toBe('anthropic:claude-sonnet-4-6');
    expect(records[0].model).toBe('anthropic:claude-sonnet-4-6');
  });
});

describe('chat_fallback_chain — ChatResult.model reports answering model', () => {
  test('after fallback, ChatResult.model is the fallback model, not the primary', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    __setChatTransportForTests(async (opts) => {
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        throw new AITransientError('upstream 503');
      }
      return successResult('openai:gpt-5');
    });

    const res = await chat(makeOpts());
    expect(res.model).toBe('openai:gpt-5');
    expect(res.providerId).toBe('openai');
  });

  test('when primary succeeds, ChatResult.model is the primary (no telemetry noise)', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-5'],
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-x' },
    });

    const seen: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.model ?? '');
      return successResult('anthropic:claude-sonnet-4-6');
    });

    const res = await chat(makeOpts());
    expect(seen).toEqual(['anthropic:claude-sonnet-4-6']);
    expect(res.model).toBe('anthropic:claude-sonnet-4-6');
  });
});
