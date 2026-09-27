// R1 fixture: a fake Curion entry that IGNORES SIGTERM and never sends any IPC
// message or exits on its own — modeling a hung/misbehaving child so the parent's
// SIGTERM-then-SIGKILL backstop (`orchestrator/child.ts`) is the only thing that can
// ever reap it. Writes its own pid to CURIOCITY_TEST_PID_FILE so the test can probe
// its liveness directly with `process.kill(pid, 0)`.
import { writeFileSync } from 'node:fs';

const pidFile = process.env['CURIOCITY_TEST_PID_FILE'];
if (pidFile) writeFileSync(pidFile, String(process.pid));

process.on('SIGTERM', () => {
  // Deliberately ignore — only SIGKILL can end this process.
});

// Keep the event loop alive indefinitely without ever sending an IPC 'result'/'fatal'
// message, so the parent's timeout backstop is the only path that resolves the trial.
setInterval(() => {}, 1000);
