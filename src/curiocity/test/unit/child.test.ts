import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { runChildTrial } from '../../src/orchestrator/child';
import { trialSpecSchema, type TrialSpec } from '../../src/shared/ipc';

/**
 * C10: the child's stdout/stderr were piped but never drained, so a module-load
 * failure or uncaught exception in the curion wrote its stack to stderr where nobody
 * read it, and the parent synthesized a bare, reasonless `agent-crash`. `child.ts`
 * must now drain stderr and surface a bounded (~8KB) tail via `onLog` when it
 * synthesizes `agent-crash`/`launch-error`, so the crash is diagnosable.
 *
 * This forks a FAKE Curion entry (never the real one) that crashes at import time —
 * writing to stderr and throwing before it ever sends an IPC message — exactly the
 * "module-load failure" scenario the finding describes.
 */

const CRASHING_ENTRY = fileURLToPath(
  new URL('../fixtures/crashing-curion/throw-on-import.mjs', import.meta.url),
);

function minimalSpec(): TrialSpec {
  return trialSpecSchema.parse({
    agentId: 'mock',
    caseName: 'c10-case',
    repeat: 1,
    timeoutSec: 20,
    prompt: 'irrelevant — the fake entry crashes before reading it',
    qna: 'irrelevant',
    models: {},
    profile: {},
    adapter: 'mock',
    runDir: '/tmp/irrelevant-c10-rundir',
  });
}

describe('C10: runChildTrial drains stderr and surfaces a bounded tail on crash', () => {
  it('reports agent-crash and logs an 8KB-bounded stderr tail (later output survives, earlier is dropped)', async () => {
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const { result, wroteArtifacts } = await runChildTrial({
      spec: minimalSpec(),
      childEnv: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      timeoutMs: 10_000,
      entry: { path: CRASHING_ENTRY, execArgv: [] },
      onLog: (msg, fields) => logs.push({ msg, ...(fields ? { fields } : {}) }),
    });

    expect(result.status).toBe('agent-crash');
    expect(wroteArtifacts).toBe(false);

    const stderrLog = logs.find((l) => l.fields?.['tag'] === 'child-stderr');
    expect(stderrLog).toBeDefined();
    const tail = String(stderrLog!.fields!['tail']);
    // The tail is bounded to ~8KB, so the marker written FIRST (long before the 9000
    // filler bytes) must have been pushed out, while the marker written LAST survives.
    expect(tail).not.toContain('BEGIN-MARKER-should-be-pushed-out-of-the-8KB-tail');
    expect(tail).toContain('END-MARKER-must-survive-in-the-tail');
    expect(tail.length).toBeLessThanOrEqual(8 * 1024);
  });
});
