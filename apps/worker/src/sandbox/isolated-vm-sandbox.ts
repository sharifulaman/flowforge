import { FatalError, type Sandbox, type SandboxResult } from '@flowforge/connector-sdk';
import ivm from 'isolated-vm';

export interface SandboxLimits {
  /** Isolate heap limit (MB, min 8). */
  memoryMb: number;
  /** CPU + wall-clock limit per execution (ms). */
  timeoutMs: number;
  /** Max serialized size of the returned value. */
  maxOutputBytes: number;
  maxLogEntries: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryMb: 64,
  timeoutMs: 5_000,
  maxOutputBytes: 1024 * 1024,
  maxLogEntries: 100,
};

const BOOTSTRAP = `
  'use strict';
  // Capture the host log bridge in a closure and remove it from the user's global scope.
  const __log = globalThis.__log;
  delete globalThis.__log;
  const __fmt = (v) => {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const __mk = (level) => (...args) => __log(level, args.map(__fmt).join(' '));
  globalThis.console = Object.freeze({ log: __mk('log'), info: __mk('info'), warn: __mk('warn'), error: __mk('error'), debug: __mk('log') });
`;

/**
 * Runs user JavaScript in a fresh V8 isolate per execution:
 *  - separate heap with a hard memory limit; no access to Node APIs, require, process, fs or network
 *  - CPU timeout enforced by V8 plus a wall-clock guard (never-settling promises)
 *  - input enters and output leaves as copies (JSON); output size is capped
 * The user's code is the body of an async function receiving `input`; `return` its result.
 */
export class IsolatedVmSandbox implements Sandbox {
  private readonly limits: SandboxLimits;

  constructor(limits: Partial<SandboxLimits> = {}) {
    this.limits = { ...DEFAULT_SANDBOX_LIMITS, ...limits };
  }

  async run(code: string, input: Record<string, unknown>, opts: { timeoutMs?: number; memoryMb?: number } = {}): Promise<SandboxResult> {
    const timeoutMs = Math.min(opts.timeoutMs ?? this.limits.timeoutMs, 60_000);
    const memoryMb = Math.max(8, Math.min(opts.memoryMb ?? this.limits.memoryMb, 256));
    const logs: SandboxResult['logs'] = [];
    const isolate = new ivm.Isolate({ memoryLimit: memoryMb });
    let wallTimer: NodeJS.Timeout | undefined;

    try {
      const context = await isolate.createContext();
      const jail = context.global;
      await jail.set(
        '__log',
        new ivm.Callback((level: string, message: string) => {
          if (logs.length >= this.limits.maxLogEntries) return;
          const lvl = (['log', 'info', 'warn', 'error'].includes(level) ? level : 'log') as SandboxResult['logs'][number]['level'];
          logs.push({ level: lvl, message: String(message).slice(0, 2_000) });
        }),
      );
      await context.eval(`(() => {${BOOTSTRAP}})()`);
      await jail.set('__input', new ivm.ExternalCopy(JSON.parse(JSON.stringify(input ?? {}))).copyInto());
      // Remove the helpers from the user's reach after wiring console.
      const wrapped = `(async function () {
        const input = globalThis.__input;
        delete globalThis.__input;
        ${code}
      })().then((r) => JSON.stringify(r === undefined ? null : r))`;

      const script = await isolate.compileScript(wrapped, { filename: 'code-step.js' }).catch((err: Error) => {
        throw new FatalError(`Syntax error in code: ${err.message}`, 'CODE_SYNTAX_ERROR');
      });

      const execution = script.run(context, { timeout: timeoutMs, promise: true, copy: true }) as Promise<string>;
      const wallClock = new Promise<never>((_, reject) => {
        wallTimer = setTimeout(() => reject(new FatalError(`Code timed out after ${timeoutMs} ms`, 'CODE_TIMEOUT')), timeoutMs + 100);
      });
      const json = await Promise.race([execution, wallClock]);

      if (typeof json === 'string' && Buffer.byteLength(json) > this.limits.maxOutputBytes) {
        throw new FatalError(`Code output exceeds ${Math.round(this.limits.maxOutputBytes / 1024)} KB`, 'CODE_OUTPUT_TOO_LARGE');
      }
      return { result: json === undefined ? null : JSON.parse(json), logs };
    } catch (err) {
      // Keep console output on failure — it's what users need to debug their code.
      const mapped = this.mapError(err, isolate, timeoutMs, memoryMb);
      throw new FatalError(mapped.message, (mapped as FatalError).code ?? 'CODE_ERROR', { logs });
    } finally {
      if (wallTimer) clearTimeout(wallTimer);
      if (!isolate.isDisposed) isolate.dispose();
    }
  }

  private mapError(err: unknown, isolate: ivm.Isolate, timeoutMs: number, memoryMb: number): Error {
    if (err instanceof FatalError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(message)) return new FatalError(`Code timed out after ${timeoutMs} ms`, 'CODE_TIMEOUT');
    if (isolate.isDisposed || /memory limit|disposed/i.test(message)) {
      return new FatalError(`Code exceeded the ${memoryMb} MB memory limit`, 'CODE_MEMORY_LIMIT');
    }
    if (/JSON|circular/i.test(message)) return new FatalError('Code must return JSON-serializable data', 'CODE_BAD_OUTPUT');
    return new FatalError(`Code error: ${message}`, 'CODE_ERROR');
  }
}
