import { FatalError } from '@flowforge/connector-sdk';
import { describe, expect, it } from 'vitest';
import { IsolatedVmSandbox } from '../src/sandbox/isolated-vm-sandbox';

const sandbox = new IsolatedVmSandbox({ timeoutMs: 1_000, memoryMb: 16 });

describe('IsolatedVmSandbox', () => {
  it('runs code with input and returns JSON output', async () => {
    const r = await sandbox.run(
      `const total = input.items.reduce((s, i) => s + i.price * i.qty, 0);
       return { total, count: input.items.length, upper: input.name.toUpperCase() };`,
      { name: 'ada', items: [{ price: 2.5, qty: 2 }, { price: 1, qty: 3 }] },
    );
    expect(r.result).toEqual({ total: 8, count: 2, upper: 'ADA' });
  });

  it('supports async/await and returns null for no return', async () => {
    expect((await sandbox.run('const x = await Promise.resolve(41); return x + 1;', {})).result).toBe(42);
    expect((await sandbox.run('const y = 1;', {})).result).toBeNull();
  });

  it('captures console output', async () => {
    const r = await sandbox.run('console.log("hi", { a: 1 }); console.warn("careful"); console.error(new Error("e").message); return 1;', {});
    expect(r.logs).toEqual([
      { level: 'log', message: 'hi {"a":1}' },
      { level: 'warn', message: 'careful' },
      { level: 'error', message: 'e' },
    ]);
  });

  it('has no access to Node.js, the host or the network', async () => {
    const probe = await sandbox.run(
      `return {
        require: typeof require, process: typeof process, fetch: typeof fetch, Buffer: typeof Buffer,
        setTimeout: typeof setTimeout, module: typeof module, globalKeys: Object.keys(globalThis).sort(), hasLogBridge: '__log' in globalThis,
      };`,
      {},
    );
    expect(probe.result).toEqual({
      require: 'undefined',
      process: 'undefined',
      fetch: 'undefined',
      Buffer: 'undefined',
      setTimeout: 'undefined',
      module: 'undefined',
      globalKeys: [], // nothing injected is visible (console is a non-enumerable built-in)
      hasLogBridge: false,
    });
    // Escapes via the constructor chain only reach the isolate's own (empty) global.
    const escape = await sandbox.run(`return (function(){}).constructor('return process')();`, {}).catch((e) => e);
    expect(escape).toMatchObject({ code: 'CODE_ERROR', message: 'Code error: process is not defined' });
    const viaThis = await sandbox.run(`return typeof this?.process + typeof globalThis.require;`, {});
    expect(viaThis.result).toBe('undefinedundefined');
  });

  it('does not leak state between executions', async () => {
    await sandbox.run('globalThis.secret = "from-run-1";', {});
    expect((await sandbox.run('return typeof globalThis.secret;', {})).result).toBe('undefined');
  });

  it('kills infinite loops (CPU timeout)', async () => {
    const t0 = Date.now();
    const err = await sandbox.run('while (true) {}', {}).catch((e) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect(err.code).toBe('CODE_TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('kills never-settling promises (wall-clock timeout)', async () => {
    const err = await sandbox.run('await new Promise(() => {});', {}).catch((e) => e);
    expect(err.code).toBe('CODE_TIMEOUT');
  });

  it('enforces the memory limit', async () => {
    const err = await sandbox.run('const a = []; while (true) a.push("x".repeat(1e5));', {}).catch((e) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect(['CODE_MEMORY_LIMIT', 'CODE_TIMEOUT']).toContain(err.code);
    // The sandbox stays usable afterwards.
    expect((await sandbox.run('return 1;', {})).result).toBe(1);
  });

  it('reports syntax errors, thrown errors and bad output clearly', async () => {
    expect((await sandbox.run('return {', {}).catch((e) => e)).code).toBe('CODE_SYNTAX_ERROR');
    const thrown = await sandbox.run('throw new Error("nope")', {}).catch((e) => e);
    expect(thrown).toMatchObject({ code: 'CODE_ERROR', message: 'Code error: nope' });
    const circular = await sandbox.run('const a = {}; a.a = a; return a;', {}).catch((e) => e);
    expect(circular.code).toBe('CODE_BAD_OUTPUT');
  });

  it('caps output size', async () => {
    const small = new IsolatedVmSandbox({ maxOutputBytes: 1_000 });
    expect((await small.run('return "x".repeat(5000);', {}).catch((e) => e)).code).toBe('CODE_OUTPUT_TOO_LARGE');
  });

  it('cannot mutate the caller’s input', async () => {
    const input = { list: [1, 2] };
    await sandbox.run('input.list.push(3); return null;', input);
    expect(input.list).toEqual([1, 2]);
  });
});
