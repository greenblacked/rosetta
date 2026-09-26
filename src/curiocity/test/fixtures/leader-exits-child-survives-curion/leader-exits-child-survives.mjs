// F7 fixture: a fake Curion entry (the process-group LEADER, since the parent forks it
// with `detached: true`) that spawns a plain, same-group child which ignores SIGTERM and
// never exits on its own, then — unlike test/fixtures/ignore-sigterm-curion — the LEADER
// itself DOES react to SIGTERM and exits promptly. This models a real curion that
// unwinds cleanly on SIGTERM while a teardown/setup subprocess it spawned (sharing its
// process group) traps SIGTERM and is left behind.
//
// Never sends any IPC 'result'/'fatal' message, so the parent's timeout backstop
// (`orchestrator/child.ts`) is the only path that resolves the trial. Writes the leader's
// own pid to CURIOCITY_TEST_PID_FILE and the spawned child's pid to
// CURIOCITY_TEST_CHILD_PID_FILE so the test can probe each one's liveness directly with
// `process.kill(pid, 0)`.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.env['CURIOCITY_TEST_PID_FILE'];
const childPidFile = process.env['CURIOCITY_TEST_CHILD_PID_FILE'];

// Plain (non-detached) spawn: on POSIX this child inherits the LEADER's process group
// (no setsid), so it is a genuine same-group member — exactly what a real teardown/setup
// subprocess would be.
const child = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
  { stdio: 'ignore' },
);

if (childPidFile && child.pid) writeFileSync(childPidFile, String(child.pid));
if (pidFile) writeFileSync(pidFile, String(process.pid));

// The LEADER itself exits promptly on SIGTERM — unlike the child it just spawned.
process.on('SIGTERM', () => {
  process.exit(0);
});

// Keep the leader alive without ever sending an IPC message, so the parent's timeout
// backstop is the only thing that resolves the trial.
setInterval(() => {}, 1000);
