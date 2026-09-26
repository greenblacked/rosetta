import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { TerminalSession } from '../../src/terminal/session';
import type { SubmitMode } from '../../src/terminal/types';

/**
 * TerminalSession (§5.3): PTY + headless emulator. Snapshots are the rendered,
 * ANSI-free visible grid; input honors backpressure via chunked writes.
 */

function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('TerminalSession', () => {
  it('renders a bounded, ANSI-free snapshot of the visible grid', async () => {
    const s = new TerminalSession({
      command: '/bin/sh',
      args: ['-c', 'printf "\\033[31mRED\\033[0m plain\\n"; sleep 0.2'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      submit: 'enter',
    });
    await waitFor(() => s.snapshot().includes('RED'));
    const snap = s.snapshot();
    expect(snap).toContain('RED plain');
    expect(snap).not.toContain('['); // no raw ANSI escapes
    expect(s.panes).toHaveLength(1);
    expect(s.primary.id).toBe('primary');
    s.kill();
  });

  it('reports exit and delivers input written to the PTY', async () => {
    const s = new TerminalSession({
      command: '/bin/sh',
      args: ['-c', 'read line; echo "got:$line"'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      submit: 'enter',
    });
    let exited = false;
    s.onExit(() => {
      exited = true;
    });
    await s.submitLine('hello');
    await waitFor(() => s.snapshot().includes('got:hello'));
    await waitFor(() => exited);
    expect(s.hasExited).toBe(true);
  });

  it('paste+enter delivers a submitted line over a real PTY (markers stripped by consumer)', async () => {
    // End-to-end over a real PTY with the PRODUCTION submit path (bracketed paste, §5.3):
    // a consumer that enables bracketed-paste mode (DECSET 2004) at startup, accumulates
    // stdin, strips the paste markers, and echoes on the trailing CR — proving the
    // discrete Enter terminates the paste as a genuine submit AND that the harness only
    // wraps once it has OBSERVED the app's mode.
    const consumer = [
      "process.stdout.write('\\x1b[?2004h');",
      "let b='';",
      "process.stdin.on('data',d=>{",
      "  b+=d.toString();",
      "  if(b.includes('\\r')||b.includes('\\n')){",
      "    const s=b.replace(/\\x1b\\[20[01]~/g,'').replace(/[\\r\\n]+/g,'');",
      "    process.stdout.write('got:'+s+'\\n');",
      "    process.exit(0);",
      "  }",
      "});",
    ].join('');
    const s = new TerminalSession({
      command: process.execPath,
      args: ['-e', consumer],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      submit: 'paste+enter',
    });
    let exited = false;
    s.onExit(() => {
      exited = true;
    });
    // Wait until the harness has OBSERVED the app's bracketed-paste mode before submitting.
    await waitFor(() => s.bracketedPasteMode);
    await s.submitLine('English');
    await waitFor(() => s.snapshot().includes('got:English'));
    await waitFor(() => exited);
    expect(s.hasExited).toBe(true);
  });

  // §5.3 binding rule: the Enter keystroke is ALWAYS a SEPARATE PTY write, after the
  // body — never `text\r` in one write (root cause of the M6.5 codex submit failure).
  // §5.3 DECSET ruling: wrapping is MODE-OBSERVED — the paste markers are sent only while
  // the app has bracketed-paste mode enabled (it emitted `ESC[?2004h`).
  //
  // `enablePaste` picks the child: one that turns bracketed-paste mode ON at startup, or
  // one that never does. When ON, we wait until the session has OBSERVED the mode before
  // capturing the submit sequence.
  async function captureSubmit(
    mode: SubmitMode,
    text: string,
    enablePaste: boolean,
  ): Promise<string[]> {
    const script = enablePaste
      ? "process.stdout.write('\\x1b[?2004h'); setTimeout(()=>{}, 3000);"
      : 'setTimeout(()=>{}, 3000);';
    const s = new TerminalSession({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      submit: mode,
    });
    if (enablePaste) await waitFor(() => s.bracketedPasteMode);
    const writes: string[] = [];
    const spy = vi.spyOn(s, 'write').mockImplementation(async (input: string) => {
      writes.push(input);
    });
    return s.submitLine(text).then(() => {
      spy.mockRestore();
      s.kill();
      return writes;
    });
  }

  // WRAPPED state (mode observed enabled): every paste submit (paste+enter and the
  // type+enter alias) is FOUR writes — open marker, text, close marker, discrete CR.
  for (const mode of ['paste+enter', 'type+enter'] as SubmitMode[]) {
    it(`submitLine (${mode}, mode enabled) → bracketed paste as four separate writes`, async () => {
      const writes = await captureSubmit(mode, 'English', true);
      expect(writes).toEqual(['\x1b[200~', 'English', '\x1b[201~', '\r']);
    });
  }

  // WRAPPED state: single-line text is wrapped just the same — no content inspection.
  it('submitLine (paste+enter, mode enabled) wraps single-line text with no \\n-detection', async () => {
    const writes = await captureSubmit('paste+enter', 'one-word', true);
    expect(writes).toEqual(['\x1b[200~', 'one-word', '\x1b[201~', '\r']);
  });

  // WRAPPED state: a multi-line payload keeps its embedded newline as literal composer
  // text inside the paste (never an early submit); the ONE Enter at the end submits.
  it('submitLine (paste+enter, mode enabled) keeps embedded newlines literal inside the paste', async () => {
    const writes = await captureSubmit('paste+enter', 'line one\nline two', true);
    expect(writes).toEqual(['\x1b[200~', 'line one\nline two', '\x1b[201~', '\r']);
  });

  // UNWRAPPED fallback (mode NOT enabled): a paste profile degrades to the plain two-write
  // sequence — the markers would be meaningless to an app that never turned the mode on.
  it('submitLine (paste+enter, mode NOT enabled) → plain [text, "\\r"] with no paste markers', async () => {
    const writes = await captureSubmit('paste+enter', 'English', false);
    expect(writes).toEqual(['English', '\r']);
  });

  // `enter` is the plain two-write FALLBACK — never wrapped, even when the app HAS enabled
  // bracketed-paste mode. This is also the "raw text is never wrapped" assertion.
  it('submitLine (enter, mode enabled) → plain [text, "\\r"] — never wrapped', async () => {
    const writes = await captureSubmit('enter', 'English', true);
    expect(writes).toEqual(['English', '\r']);
  });

  // Mode-toggle mid-session: a child that turns bracketed paste ON then OFF. The FIRST
  // submit (mode on) wraps; after the app disables the mode, the SECOND submit degrades to
  // plain — proving the wrap decision tracks the app's live mode, not a static profile bit.
  it('submitLine tracks the app mode across a mid-session DECSET toggle', async () => {
    const script =
      "process.stdout.write('\\x1b[?2004h');" +
      "setTimeout(()=>process.stdout.write('\\x1b[?2004l'), 300);" +
      'setTimeout(()=>{}, 3000);';
    const s = new TerminalSession({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      submit: 'paste+enter',
    });

    await waitFor(() => s.bracketedPasteMode); // app enabled the mode
    const wrapped: string[] = [];
    let spy = vi.spyOn(s, 'write').mockImplementation(async (input: string) => {
      wrapped.push(input);
    });
    await s.submitLine('first');
    spy.mockRestore();
    expect(wrapped).toEqual(['\x1b[200~', 'first', '\x1b[201~', '\r']);

    await waitFor(() => !s.bracketedPasteMode); // app disabled the mode
    const plain: string[] = [];
    spy = vi.spyOn(s, 'write').mockImplementation(async (input: string) => {
      plain.push(input);
    });
    await s.submitLine('second');
    spy.mockRestore();
    expect(plain).toEqual(['second', '\r']);

    s.kill();
  });

  it('C8: write() never splits a UTF-16 surrogate pair at the 1024-char chunk boundary', async () => {
    // `cat -u` echoes stdin verbatim over the PTY (unbuffered, so it doesn't wait for
    // EOF). A string with exactly 1023 plain chars before an astral character (an emoji
    // = one surrogate PAIR, i.e. two UTF-16 code units) puts that pair's high surrogate
    // at index 1023 and low surrogate at 1024 — exactly the 1024-char WRITE_CHUNK
    // boundary. Before the fix, slicing there put each surrogate half in its own chunk;
    // each chunk is UTF-8 encoded independently, and a lone surrogate encodes as U+FFFD
    // (the corruption fable evidence reproduced) instead of round-tripping the emoji.
    const marker = 'ZZMARKERZZ';
    const payload = 'a'.repeat(1023) + '\u{1F600}' + marker; // 😀 = surrogate pair
    const s = new TerminalSession({
      command: '/bin/sh',
      args: ['-c', 'cat -u'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      submit: 'enter',
    });
    await s.write(payload);
    await waitFor(() => s.snapshot().replace(/\n/g, '').includes(marker));
    // The terminal line-wraps at its column width — join rows back into one line before
    // checking content, since that wrapping (not surrogate corruption) is expected here.
    const rendered = s.snapshot().replace(/\n/g, '');
    expect(rendered).toContain('\u{1F600}' + marker);
    expect(rendered).not.toContain('�');
    s.kill();
  });

  it('C2: kill() signals the PTY PROCESS GROUP (not just the leader), reaping a SIGHUP-immune background child', async () => {
    // node-pty's own `pty.kill()` sends a signal to the leader PID only. The PTY leader
    // (forkpty) is its own process-group leader, so a background child it spawns shares
    // that group but is NOT reached by a single-PID signal — it survives, orphaned, once
    // the leader exits. `trap '' HUP` on the leader models a real agent CLI that ignores
    // SIGHUP (the OLD single-PID signal); `kill()` must still reach the child because it
    // signals the whole group with SIGTERM, not just the leader with SIGHUP.
    const script = "trap '' HUP; sleep 30 & echo child_pid:$!; wait";
    const s = new TerminalSession({
      command: '/bin/sh',
      args: ['-c', script],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      submit: 'enter',
    });

    let childPid: number | null = null;
    await waitFor(() => {
      const m = s.snapshot().match(/child_pid:(\d+)/);
      if (m) childPid = Number(m[1]);
      return childPid !== null;
    });
    const pid = childPid as unknown as number;
    expect(pid).not.toBeNull();
    // Confirm the background `sleep` is really alive before kill (signal 0 = existence probe).
    expect(() => process.kill(pid, 0)).not.toThrow();

    s.kill();

    // The group SIGTERM should reap it well within the 5s SIGKILL-escalation window.
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false; // still alive
      } catch {
        return true; // ESRCH — gone
      }
    }, 8000);
  });

  it('R6: kill() resolves only once the SIGTERM-ignoring group is actually gone (not fire-and-forget)', async () => {
    // Before the fix, `kill()` was synchronous: it sent SIGTERM and scheduled the
    // SIGKILL escalation on an `.unref()`'d timer, then returned immediately. A caller
    // that `await`s the (non-promise) return value sees that resolve at once — long
    // before the group is actually dead — and, worse, if nothing else keeps the event
    // loop alive (the normal teardown case), the process exits before the unref'd timer
    // ever fires, so the escalation is dropped entirely and the agent survives.
    //
    // `trap '' TERM` makes the leader itself ignore SIGTERM, so only the 5s SIGKILL
    // escalation can end it. Awaiting `kill()` must not return until that has happened.
    const pidDir = mkdtempSync(join(tmpdir(), 'curiocity-r6-'));
    const pidFile = join(pidDir, 'pid');
    try {
      const script = `trap '' TERM; echo $$ > ${pidFile}; echo READY; sleep 30`;
      const s = new TerminalSession({
        command: '/bin/sh',
        args: ['-c', script],
        cwd: process.cwd(),
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        submit: 'enter',
      });

      await waitFor(() => s.snapshot().includes('READY'));
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(() => process.kill(pid, 0)).not.toThrow(); // alive, trap installed

      await s.kill();

      // By the time the awaited kill() resolves, the SIGKILL escalation must already
      // have reaped the SIGTERM-immune process.
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('F8: kill() still reaps a backgrounded group member after the PTY leader has already exited', async () => {
    // Before the fix, `kill()` returned immediately when `this.exited` was already true
    // (the PTY leader's main process had exited) WITHOUT ever signalling the leader's
    // process group — so a backgrounded, TERM-ignoring subprocess it spawned (e.g. via
    // `&`) outlived the curion. The shell here backgrounds a `sleep` that traps and
    // ignores SIGTERM, then exits its own main process immediately — modeling exactly
    // that scenario. `kill()` must still reach the surviving group member.
    const pidDir = mkdtempSync(join(tmpdir(), 'curiocity-f8-'));
    const pidFile = join(pidDir, 'pid');
    try {
      const script = `trap '' TERM; sleep 30 & echo $! > ${pidFile}; echo BACKGROUNDED; exit 0`;
      const s = new TerminalSession({
        command: '/bin/sh',
        args: ['-c', script],
        cwd: process.cwd(),
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        submit: 'enter',
      });

      // Wait for the main shell process to have exited on its own, BEFORE kill() is
      // ever called — the exact precondition the finding describes.
      await waitFor(() => s.hasExited);
      await waitFor(() => existsSync(pidFile));
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(() => process.kill(pid, 0)).not.toThrow(); // backgrounded sleep still alive

      await s.kill();

      // kill() must have signalled the (still-existing) process group and reaped the
      // TERM-ignoring background subprocess via the SIGKILL escalation, even though the
      // PTY leader itself was already gone when kill() was called.
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  }, 10_000);
});
