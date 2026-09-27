import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childToParentSchema, type TrialSpec } from '../shared/ipc';
import type { QnaEntry } from '../shared/trajectory';
import { SCHEMA_VERSION, trialResultSchema, type TrialResult } from '../results/schema';
import { writeTrial } from '../results/store';

/**
 * Parent-side child runner (§4). Forks one Curion (`curion/main`) with the
 * allow-listed env, ships the `TrialSpec` over IPC, streams events, and enforces
 * the per-trial timeout with a process-TREE kill → status `timeout`. The child
 * writes its own trial artifacts on normal completion; the parent writes a minimal
 * `trial.json` for parent-synthesized outcomes (timeout / unexpected death).
 *
 * (C1) This timeout is a BACKSTOP, not the primary timeout path: the child's own
 * engine deadline (lifecycle.ts `maxWallClockMs`) is set to expire well before this
 * fires, so in normal operation the child exits on its own via its graceful timeout
 * path (trajectory/transcript/diff/teardown/temp cleanup) and this timer is cleared
 * first. If the child is still alive when this DOES fire, it is sent SIGTERM first
 * (giving it a last chance to unwind) and only SIGKILL'd 10s later.
 */

/**
 * Resolve the Curion child entry from the URL of THIS module — correct in BOTH run modes:
 *  - source/tests (tsx): this file is `src/orchestrator/child.ts`, so the sibling is
 *    `../curion/main.ts` and the child needs `--import tsx` to run TypeScript.
 *  - built dist: the bundle collapses the tree — this code lives in a dist-root file
 *    (`dist/cli.js` or a shared chunk), and tsup emits the child entry at
 *    `dist/curion/main.js`, so the sibling is `./curion/main.js` (NOT `../`, which would
 *    escape dist).
 * Getting this wrong makes every trial fail to load the child → `agent-crash` (the class
 * of bug this pure function is unit-tested against; see tsup.config.ts). Exported for that
 * test so both the .ts and simulated-.js layouts are pinned.
 */
export function resolveCurionEntry(moduleUrl: string): { path: string; execArgv: string[] } {
  const isTs = moduleUrl.endsWith('.ts');
  return {
    path: fileURLToPath(new URL(isTs ? '../curion/main.ts' : './curion/main.js', moduleUrl)),
    execArgv: isTs ? ['--import', 'tsx'] : [],
  };
}

const { path: CURION_MAIN, execArgv: EXEC_ARGV } = resolveCurionEntry(import.meta.url);

export interface RunChildOptions {
  spec: TrialSpec;
  childEnv: Record<string, string>;
  /** Per-trial wall-clock cap (ms); on expiry the parent process-tree-kills → timeout. */
  timeoutMs: number;
  onLog?: (msg: string, fields?: Record<string, unknown>) => void;
  onQna?: (entry: QnaEntry) => void;
  onMirror?: (data: string) => void;
  /** Test-only: fork this entry instead of the real Curion (`curion/main`), so a crash /
   *  stderr-draining test does not need to run a real trial. Production callers omit it. */
  entry?: { path: string; execArgv: string[] };
}

export interface ChildTrialResult {
  result: TrialResult;
  /** True when the child already wrote its trial.json + artifacts (§14). */
  wroteArtifacts: boolean;
}

function synthResult(spec: TrialSpec, status: TrialResult['status'], totalMs: number): TrialResult {
  return trialResultSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    agent: spec.agentId,
    case: spec.caseName,
    repeat: spec.repeat,
    status,
    evaluators: [],
    turnCount: 0,
    qna: [],
    timings: { totalMs },
  });
}

/** (C10) Bounded ring tail kept from the child's stderr, surfaced via `onLog` on a
 *  crash so a module-load failure or uncaught exception is diagnosable instead of a
 *  bare `agent-crash` with no reason. */
const STDERR_TAIL_BYTES = 8 * 1024;

export function runChildTrial(opts: RunChildOptions): Promise<ChildTrialResult> {
  const { spec, childEnv, timeoutMs } = opts;
  const entryPath = opts.entry?.path ?? CURION_MAIN;
  const entryExecArgv = opts.entry?.execArgv ?? EXEC_ARGV;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = fork(entryPath, [], {
      env: childEnv,
      execArgv: entryExecArgv,
      detached: true, // own process group → whole tree (curion + PTY) killable
      // (C10) stdout is ignored (pino's own child-side log write is not this parent's
      // concern); stderr IS drained (never left un-piped) so it can never fill and
      // block the child, and its tail is captured for crash diagnostics below.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    let settled = false;
    let resultMsg: TrialResult | null = null;
    let fatal: string | null = null;
    let stderrTail = '';

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });

    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    // (R1) `killTimer`/`killPoll` schedule the SIGKILL escalation and must NOT be
    // cancelled by `finish()` — `finish()` resolves the returned promise (so the
    // orchestrator can move on to the next trial) but that is orthogonal to whether the
    // child process TREE is actually dead yet. Before this fix, `finish()` cleared
    // `killTimer` unconditionally, so the very `finish()` call inside the timeout
    // handler below cancelled the SIGKILL it had just scheduled a line earlier — a
    // child that ignores SIGTERM then lived forever.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killPoll: ReturnType<typeof setInterval> | undefined;
    const clearKillTimer = (): void => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      killTimer = undefined;
      if (killPoll !== undefined) clearInterval(killPoll);
      killPoll = undefined;
    };

    // (F7) `process.kill(-pid, 0)` probes whether the GROUP still has any member alive.
    // Only ESRCH means "no such process/group" (gone); EPERM (exists, just not
    // signalable) and any other error mean it is still there.
    const isGroupGone = (pid: number): boolean => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'ESRCH';
      }
    };

    const finish = (res: ChildTrialResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    // (C1/C2) The child's own engine deadline (lifecycle.ts) is set to expire well
    // before this fires, so in normal operation the child exits on its own and this
    // timer is cleared first. This is a BACKSTOP: SIGTERM first (letting a still-alive
    // child unwind through its own timeout/teardown path), SIGKILL only if the GROUP
    // still has a member alive 10s later.
    //
    // (F7) SIGTERM only reaches the group; it does NOT guarantee every member exits.
    // The curion (group leader) can exit on its own SIGTERM handling while a same-group
    // child it spawned (e.g. a teardown/setup subprocess trapping TERM) ignores it and
    // survives, orphaned. So the escalation polls the GROUP — via `process.kill(-pid,
    // 0)`, not just the leader's own 'exit' event — and only sends SIGKILL, at the
    // deadline, if anything of the group remains; it then stops. This never keeps the
    // parent alive past the fixed 10s escalation window.
    const timer = setTimeout(() => {
      killTree('SIGTERM');
      const pid = child.pid;
      if (pid === undefined) {
        // No pid to address the group by — fall back to a single-shot SIGKILL.
        killTimer = setTimeout(() => killTree('SIGKILL'), 10_000);
      } else {
        const POLL_MS = 100;
        const SIGKILL_AT_MS = 10_000;
        let elapsed = 0;
        killPoll = setInterval(() => {
          if (isGroupGone(pid)) {
            clearKillTimer();
            return;
          }
          elapsed += POLL_MS;
          if (elapsed >= SIGKILL_AT_MS) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              /* ESRCH: group already gone */
            }
            clearKillTimer();
          }
        }, POLL_MS);
      }
      finish({ result: synthResult(spec, 'timeout', Date.now() - started), wroteArtifacts: false });
    }, timeoutMs);

    child.on('message', (raw) => {
      const parsed = childToParentSchema.safeParse(raw);
      if (!parsed.success) return;
      const msg = parsed.data;
      switch (msg.type) {
        case 'log':
          opts.onLog?.(msg.msg, msg.fields);
          break;
        case 'qna':
          opts.onQna?.(msg.entry);
          break;
        case 'mirror':
          opts.onMirror?.(msg.data);
          break;
        case 'result': {
          const rp = trialResultSchema.safeParse(msg.result);
          if (rp.success) resultMsg = rp.data;
          break;
        }
        case 'fatal':
          fatal = msg.error;
          break;
        case 'status':
        default:
          break;
      }
    });

    child.on('error', (err) => {
      fatal = err.message;
    });

    child.on('exit', () => {
      // (R1/F7) The LEADER exiting does not mean the whole process GROUP is gone — a
      // same-group child that ignores SIGTERM can outlive it. Only stop the escalation
      // here once the group itself is confirmed gone; otherwise leave the poll started
      // in the timeout handler above running so it can still SIGKILL whatever remains
      // at the deadline. When no escalation was ever scheduled (normal completion, the
      // backstop never fired) `killPoll`/`killTimer` are unset and this is a no-op.
      if (child.pid === undefined || isGroupGone(child.pid)) {
        clearKillTimer();
      }
      if (resultMsg) {
        finish({ result: resultMsg, wroteArtifacts: true });
        return;
      }
      // No result: fatal (harness error → launch-error) or the child died (crash).
      const status = fatal ? 'launch-error' : 'agent-crash';
      // (C10) Surface the captured stderr tail so an otherwise-bare agent-crash /
      // launch-error carries the child's own diagnostics (e.g. a module-load stack).
      if (stderrTail.trim() !== '') {
        opts.onLog?.(`child-stderr tail (${status})`, { tag: 'child-stderr', tail: stderrTail });
      }
      finish({ result: synthResult(spec, status, Date.now() - started), wroteArtifacts: false });
    });

    child.send({ type: 'spec', spec });
  });
}

/** Ensure a trial.json exists for a parent-synthesized outcome (§14). */
export function writeSynthesizedTrial(runDir: string, result: TrialResult): void {
  writeTrial(runDir, result);
}
