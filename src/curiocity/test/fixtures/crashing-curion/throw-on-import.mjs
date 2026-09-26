// C10 fixture: a fake Curion entry that crashes at import time — never sends any IPC
// message and never touches stdout — modeling a module-load failure / uncaught
// exception in the real curion/main.ts, which the parent (`child.ts`) must diagnose
// from the drained stderr tail rather than reporting a bare, reasonless `agent-crash`.
process.stderr.write('BEGIN-MARKER-should-be-pushed-out-of-the-8KB-tail\n');
process.stderr.write('x'.repeat(9000) + '\n');
process.stderr.write('END-MARKER-must-survive-in-the-tail\n');
throw new Error('deliberate crash for C10 test');
