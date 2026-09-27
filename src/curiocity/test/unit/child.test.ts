import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { runChildTrial } from '../../src/orchestrator/child';
import { trialSpecSchema, type TrialSpec } from '../../src/shared/ipc';

function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

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

const IGNORE_SIGTERM_ENTRY = fileURLToPath(
  new URL('../fixtures/ignore-sigterm-curion/ignore-sigterm.mjs', import.meta.url),
);

const LEADER_EXITS_CHILD_SURVIVES_ENTRY = fileURLToPath(
  new URL(
    '../fixtures/leader-exits-child-survives-curion/leader-exits-child-survives.mjs',
    import.meta.url,
  ),
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

/**
 * R1: the backstop timer did `killTree('SIGTERM')`, scheduled `killTimer` (SIGKILL 10s
 * later), then called `finish()` — which unconditionally cleared `killTimer`. So the
 * SIGKILL escalation the timeout handler had JUST scheduled was cancelled by that same
 * handler's own `finish()` call, and a SIGTERM-ignoring child lived forever. The fix:
 * `killTimer` must survive `finish()` and only be cleared once the child actually exits.
 */
describe('R1: the SIGKILL escalation survives finish() resolving the trial as `timeout`', () => {
  it('still SIGKILLs a SIGTERM-immune child ~10s after the backstop times out', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'curiocity-r1-'));
    const pidFile = join(pidDir, 'pid');
    try {
      const { result } = await runChildTrial({
        spec: minimalSpec(),
        childEnv: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          CURIOCITY_TEST_PID_FILE: pidFile,
        },
        // Short backstop so the test doesn't wait on the spec's own timeoutSec.
        timeoutMs: 200,
        entry: { path: IGNORE_SIGTERM_ENTRY, execArgv: [] },
      });

      // `runChildTrial` resolves as soon as the backstop fires (before the child is
      // actually dead) — that resolution must not be what cancels the SIGKILL.
      expect(result.status).toBe('timeout');

      await waitFor(() => existsSync(pidFile));
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isFinite(pid)).toBe(true);

      // Right after the promise resolves, the SIGTERM-ignoring child is still alive.
      expect(() => process.kill(pid, 0)).not.toThrow();

      // The SIGKILL escalation must still fire ~10s later even though `finish()` (and
      // this test's `await`) already happened — before the fix this never came, and
      // the process would still be alive at the end of this `waitFor`.
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false; // still alive
        } catch {
          return true; // ESRCH — reaped by SIGKILL
        }
      }, 15_000);
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * F7: `killTree('SIGTERM')` signals the whole detached process GROUP, but
 * `clearKillTimer()` used to fire on the curion (group LEADER)'s own 'exit' event. A
 * curion that reacts to SIGTERM and exits promptly — while a same-group subprocess it
 * spawned (e.g. teardown/setup) traps SIGTERM and survives — cancelled the SIGKILL
 * escalation the instant the leader exited, orphaning that subprocess forever. The fix:
 * the escalation must keep polling the GROUP (not just the leader) and only stop once
 * everything in it is gone, sending SIGKILL to the group at the deadline if anything
 * remains.
 */
describe('F7: the SIGKILL escalation outlives the leader when a same-group child ignores SIGTERM', () => {
  it('still SIGKILLs the surviving same-group child ~10s after the leader itself has exited', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'curiocity-f7-'));
    const pidFile = join(pidDir, 'pid');
    const childPidFile = join(pidDir, 'child-pid');
    try {
      const { result } = await runChildTrial({
        spec: minimalSpec(),
        childEnv: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          CURIOCITY_TEST_PID_FILE: pidFile,
          CURIOCITY_TEST_CHILD_PID_FILE: childPidFile,
        },
        // Short backstop so the test doesn't wait on the spec's own timeoutSec.
        timeoutMs: 200,
        entry: { path: LEADER_EXITS_CHILD_SURVIVES_ENTRY, execArgv: [] },
      });

      expect(result.status).toBe('timeout');

      await waitFor(() => existsSync(pidFile) && existsSync(childPidFile));
      const leaderPid = Number(readFileSync(pidFile, 'utf8').trim());
      const childPid = Number(readFileSync(childPidFile, 'utf8').trim());
      expect(Number.isFinite(leaderPid)).toBe(true);
      expect(Number.isFinite(childPid)).toBe(true);

      // The leader reacts to SIGTERM and exits promptly — well before the 10s SIGKILL
      // escalation deadline — while its same-group child (ignoring SIGTERM) is still
      // alive right after that.
      await waitFor(() => {
        try {
          process.kill(leaderPid, 0);
          return false; // still alive
        } catch {
          return true; // ESRCH — leader exited on SIGTERM
        }
      }, 5_000);
      expect(() => process.kill(childPid, 0)).not.toThrow();

      // The SIGKILL escalation must still reach the surviving group member ~10s after
      // the backstop fired, even though the leader is long gone and its own 'exit'
      // event already happened. Before the fix, the leader's 'exit' cancelled the
      // escalation and this child lived forever.
      await waitFor(() => {
        try {
          process.kill(childPid, 0);
          return false; // still alive
        } catch {
          return true; // ESRCH — reaped by the group SIGKILL
        }
      }, 15_000);
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  }, 20_000);
});
