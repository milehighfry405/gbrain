/**
 * workspace-1xa4 — regression test wave for `gbrain models doctor`.
 *
 * Two bug classes covered:
 *
 *   1. Dispatch regression (RCA): `gbrain models doctor` was silently
 *      returning the read-mode routing table because `runModels` checked
 *      `args[1] === 'doctor'` while `handleCliOnly` passes subArgs
 *      (subcommand lives at args[0]). The probe code was unreachable from
 *      the CLI for ~9 versions. This test exercises the doctor dispatch
 *      path with subArgs-shape input and asserts the probe array exists.
 *
 *   2. Tier collapse: when models.default is set, every tier collapses to
 *      one provider. An outage of that provider takes all tiers down with
 *      no fallback. doctor must surface this risk as a structured signal.
 *
 * No API key required — uses `__setChatTransportForTests` to simulate
 * provider responses (including failures) deterministically.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { runModels } from '../src/commands/models.ts';

// Minimal engine duck-type that satisfies the runModels boundary. Stores
// config in a Map and returns null for unset keys (mirroring engine.getConfig
// semantics). Production engine wraps a Postgres/PGLite connection; this
// stub has no DB.
class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string): Promise<string | null> { return this.cfg.get(key) ?? null; }
  async setConfig(): Promise<void> {}
}

let stub: StubEngine;
let stdoutCapture: string;
let stderrCapture: string;
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origExit = process.exit.bind(process);
let lastExitCode: number | undefined;

function captureExit(): never {
  // Tests should fail loudly if production code calls process.exit(non-zero);
  // we intercept so a non-zero exit becomes a recorded value instead of
  // tearing down the bun test process.
  throw new Error('__captured_exit__');
}

beforeEach(() => {
  stub = new StubEngine();
  stdoutCapture = '';
  stderrCapture = '';
  lastExitCode = undefined;
  resetGateway();
  __setChatTransportForTests(null);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;

  process.exit = ((code?: number) => {
    lastExitCode = code;
    captureExit();
  }) as typeof process.exit;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exit = origExit;
  resetGateway();
  __setChatTransportForTests(null);
});

function configureWithTransport(transport: (opts: ChatOpts) => Promise<ChatResult>): void {
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    expansion_model: 'anthropic:claude-haiku-4-5-20251001',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  __setChatTransportForTests(transport);
}

function makeChatResult(model: string): ChatResult {
  return {
    text: 'ok',
    blocks: [{ type: 'text', text: 'ok' }],
    stopReason: 'end',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model,
    providerId: model.split(':')[0] ?? 'anthropic',
  };
}

function makeOkTransport(): (opts: ChatOpts) => Promise<ChatResult> {
  return async (opts) => makeChatResult(opts.model ?? 'anthropic:claude-sonnet-4-6');
}

function makeFailingTransport(err: Error): (opts: ChatOpts) => Promise<ChatResult> {
  return async () => { throw err; };
}

// Helper: parse the JSON body emitted by runModels --json, swallowing any
// non-JSON prefix lines the implementation may emit.
function parseJsonOutput(s: string): Record<string, unknown> {
  const start = s.indexOf('{');
  if (start === -1) throw new Error(`no JSON in output: ${s.slice(0, 200)}`);
  // runModels emits a single JSON document followed by a newline.
  // Slice from first `{` to last `}` to be tolerant of trailing prompts.
  const end = s.lastIndexOf('}');
  return JSON.parse(s.slice(start, end + 1));
}

describe('runModels — dispatch (workspace-1xa4 RCA)', () => {
  test('subArgs convention: args[0] === "doctor" enters probe mode (not read mode)', async () => {
    configureWithTransport(makeOkTransport());
    // Simulates `gbrain models doctor --json` as handleCliOnly invokes it:
    // subArgs is the full main argv minus the leading `models` token.
    await runModels(stub as never, ['doctor', '--json']);
    const out = parseJsonOutput(stdoutCapture);
    expect(out).toHaveProperty('probes');
    expect(out).toHaveProperty('summary');
    // Read mode emits `tiers` + `per_task` at the top level. Doctor mode
    // emits `probes` instead. The dispatch bug caused this assertion to
    // fail because the read-mode shape was returned for both forms.
    expect(out).not.toHaveProperty('per_task');
  });

  test('subArgs convention: args[0] === "help" prints usage and returns', async () => {
    configureWithTransport(makeOkTransport());
    await runModels(stub as never, ['help']);
    expect(stdoutCapture).toContain('Usage:');
    expect(stdoutCapture).toContain('gbrain models doctor');
  });

  test('subArgs convention: empty args enters read mode (--json shape)', async () => {
    configureWithTransport(makeOkTransport());
    await runModels(stub as never, ['--json']);
    const out = parseJsonOutput(stdoutCapture);
    // Read mode returns the routing table — exposed via `tiers` + `aliases`.
    expect(out).toHaveProperty('tiers');
    expect(out).toHaveProperty('aliases');
    // And does NOT have the doctor-only `probes` key.
    expect(out).not.toHaveProperty('probes');
  });
});

describe('runModels doctor — reachability probe shape', () => {
  test('--json emits probes with model, status, elapsed_ms for each unique resolved model', async () => {
    let probesFired = 0;
    configureWithTransport(async (opts) => {
      probesFired++;
      expect(opts.maxTokens).toBe(1);
      return makeChatResult(opts.model!);
    });

    await runModels(stub as never, ['doctor', '--json']);
    const out = parseJsonOutput(stdoutCapture);
    const probes = out.probes as Array<Record<string, unknown>>;

    // Every probe row carries the canonical shape.
    for (const p of probes) {
      expect(p).toHaveProperty('model');
      expect(p).toHaveProperty('status');
      expect(p).toHaveProperty('touchpoint');
      expect(typeof p.elapsed_ms).toBe('number');
    }

    // At least one chat-touchpoint probe fired (the bug class that motivated
    // v0.31.12 — the doctor must actually call gateway.chat()).
    const chatProbes = probes.filter(p => p.touchpoint === 'chat');
    expect(chatProbes.length).toBeGreaterThan(0);
    expect(probesFired).toBeGreaterThan(0);
  });

  test('dedupes by `provider:model` — tier collapse does not multiply probe count', async () => {
    let probesFired = 0;
    configureWithTransport(async (opts) => {
      probesFired++;
      return makeChatResult(opts.model!);
    });

    // Force tier collapse — every tier → anthropic:claude-sonnet-4-6.
    stub.set('models.default', 'anthropic:claude-sonnet-4-6');

    await runModels(stub as never, ['doctor', '--json']);

    // Without dedup we would fire ~12+ probes (4 tiers + 12 per-task + chat
    // + expansion). With dedup the unique-model set in this configuration
    // collapses to a small handful (sonnet + the configured expansion model).
    expect(probesFired).toBeLessThanOrEqual(4);
    expect(probesFired).toBeGreaterThan(0);
  });

  test('probe failure → status=failure-class string, no thrown error, exit code 1', async () => {
    configureWithTransport(makeFailingTransport(new Error('404 model_not_found')));
    stub.set('models.default', 'anthropic:claude-sonnet-4-6');

    try {
      await runModels(stub as never, ['doctor', '--json']);
    } catch (e) {
      // captureExit throws; expected when summary.failed > 0.
      expect((e as Error).message).toBe('__captured_exit__');
    }
    expect(lastExitCode).toBe(1);

    const out = parseJsonOutput(stdoutCapture);
    const probes = out.probes as Array<Record<string, unknown>>;
    const failed = probes.filter(p => p.status !== 'ok' && p.touchpoint === 'chat');
    expect(failed.length).toBeGreaterThan(0);
    // Error classifier picks `model_not_found` for /404/ /not_found/.
    expect(failed[0].status).toBe('model_not_found');
    expect(failed[0].message).toContain('404');
  });

  test('--skip=<provider> bypasses that provider — no probes fired against it', async () => {
    let probesFired = 0;
    configureWithTransport(async (opts) => {
      probesFired++;
      return makeChatResult(opts.model!);
    });

    stub.set('models.default', 'anthropic:claude-sonnet-4-6');
    await runModels(stub as never, ['doctor', '--json', '--skip=anthropic']);
    // Every resolved model is anthropic in this config → all skipped.
    expect(probesFired).toBe(0);
    const out = parseJsonOutput(stdoutCapture);
    const probes = out.probes as Array<Record<string, unknown>>;
    // Embedding/reranker config probes still run (they're zero-network and
    // not gated by --skip — they validate config, not provider connectivity).
    const chatProbes = probes.filter(p => p.touchpoint === 'chat');
    expect(chatProbes.length).toBe(0);
  });

  test('--no-probe emits config-resolution + tier_collapse without any chat call', async () => {
    let probesFired = 0;
    configureWithTransport(async (opts) => {
      probesFired++;
      return makeChatResult(opts.model!);
    });

    await runModels(stub as never, ['doctor', '--json', '--no-probe']);
    expect(probesFired).toBe(0);
    const out = parseJsonOutput(stdoutCapture);
    expect(out).toHaveProperty('tier_collapse');
    expect(out).toHaveProperty('summary');
  });
});

describe('runModels doctor — tier_collapse signal (workspace-1xa4 AC)', () => {
  test('all 4 tiers → one provider → collapsed=true with provider name', async () => {
    configureWithTransport(makeOkTransport());
    stub.set('models.default', 'anthropic:claude-sonnet-4-6');

    await runModels(stub as never, ['doctor', '--json', '--no-probe']);
    const out = parseJsonOutput(stdoutCapture);
    const tc = out.tier_collapse as Record<string, unknown>;

    expect(tc.collapsed).toBe(true);
    expect(tc.provider).toBe('anthropic');
    expect(tc.warning).toContain('All 4 tiers');
    expect(tc.warning).toContain('outage');
  });

  test('distinct providers across tiers → collapsed=false', async () => {
    configureWithTransport(makeOkTransport());
    // Spread tiers across providers via per-tier config keys (not models.default).
    stub.set('models.tier.utility', 'openai:gpt-4o-mini');
    stub.set('models.tier.reasoning', 'anthropic:claude-sonnet-4-6');
    stub.set('models.tier.deep', 'anthropic:claude-opus-4-7');
    stub.set('models.tier.subagent', 'anthropic:claude-sonnet-4-6');

    await runModels(stub as never, ['doctor', '--json', '--no-probe']);
    const out = parseJsonOutput(stdoutCapture);
    const tc = out.tier_collapse as Record<string, unknown>;

    expect(tc.collapsed).toBe(false);
  });
});
