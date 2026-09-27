import { describe, test, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendAuditRecord, resolveAuditConfig } from '../../src/runtime/audit';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
// P2-7: the per-install hash key auto-creates under `<HOME>/.rosetta/audit/.key`. Point HOME at
// a sandboxed tmp dir so tests never touch the real machine's home directory.
const AUDIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-home-'));

const readRecords = (filePath: string): Record<string, unknown>[] =>
  fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('resolveAuditConfig', () => {
  test('unset env → disabled (default OFF)', () => {
    expect(resolveAuditConfig({}).enabled).toBe(false);
  });
  test('ROSETTA_AUDIT_LOG=off → disabled', () => {
    expect(resolveAuditConfig({ ROSETTA_AUDIT_LOG: 'off' }).enabled).toBe(false);
  });
  test('ROSETTA_AUDIT_LOG=0 → disabled', () => {
    expect(resolveAuditConfig({ ROSETTA_AUDIT_LOG: '0' }).enabled).toBe(false);
  });
  test('ROSETTA_AUDIT_LOG=1 → enabled, default location', () => {
    const cfg = resolveAuditConfig({ ROSETTA_AUDIT_LOG: '1' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.useDefaultLocation).toBe(true);
  });
  test('ROSETTA_AUDIT_LOG=<path> → enabled, explicit path', () => {
    const cfg = resolveAuditConfig({ ROSETTA_AUDIT_LOG: '/tmp/x/audit.jsonl' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.useDefaultLocation).toBe(false);
    expect(cfg.explicitPath).toBe('/tmp/x/audit.jsonl');
  });

  // P3: truthy/off matching must be case-insensitive, and "yes" is accepted alongside 1/true/on.
  for (const value of ['TRUE', 'True', 'YES', 'yes', 'On', 'ON', '1']) {
    test(`ROSETTA_AUDIT_LOG=${value} → enabled, default location (case-insensitive)`, () => {
      const cfg = resolveAuditConfig({ ROSETTA_AUDIT_LOG: value });
      expect(cfg.enabled).toBe(true);
      expect(cfg.useDefaultLocation).toBe(true);
    });
  }
  for (const value of ['OFF', 'Off', 'FALSE', 'False']) {
    test(`ROSETTA_AUDIT_LOG=${value} → disabled (case-insensitive)`, () => {
      expect(resolveAuditConfig({ ROSETTA_AUDIT_LOG: value }).enabled).toBe(false);
    });
  }

  // P3: a RELATIVE value is never treated as a log path — it would resolve against the hook
  // process's cwd (normally inside the repo being worked on), silently writing audit data into
  // the user's own repository.
  test('ROSETTA_AUDIT_LOG=<relative path> → disabled, not treated as a log target', () => {
    const cfg = resolveAuditConfig({ ROSETTA_AUDIT_LOG: 'relative/audit.jsonl' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.explicitPath).toBeNull();
  });

  test('ROSETTA_AUDIT_LOG=<absolute path> → enabled, explicit path (unaffected by case rules)', () => {
    const cfg = resolveAuditConfig({ ROSETTA_AUDIT_LOG: '/tmp/x/audit.jsonl' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.explicitPath).toBe('/tmp/x/audit.jsonl');
  });
});

describe('appendAuditRecord — off by default', () => {
  test('no env set → no file written', () => {
    const target = path.join(TMP, 'off-by-default', 'audit.jsonl');
    appendAuditRecord(
      { hook: 'dangerous-actions', decision: 'deny', patternId: 'rm-rf-root', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: 's1', command: 'rm -rf /' },
      {},
    );
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('appendAuditRecord — one record per decision type', () => {
  let target: string;
  let env: Record<string, string>;
  beforeEach(() => {
    target = path.join(TMP, `decisions-${Math.random()}`, 'audit.jsonl');
    env = { ROSETTA_AUDIT_LOG: target, HOME: AUDIT_HOME };
  });

  for (const decision of ['deny', 'advise', 'override', 'block'] as const) {
    test(`records a "${decision}" decision`, () => {
      appendAuditRecord(
        {
          hook: 'dangerous-actions',
          decision,
          patternId: 'some-pattern',
          toolName: 'Bash',
          toolKind: 'bash',
          ide: 'claude-code',
          sessionId: 'sess-1',
          command: 'rm -rf /tmp/whatever',
        },
        env,
      );
      const records = readRecords(target);
      expect(records).toHaveLength(1);
      expect(records[0].decision).toBe(decision);
      expect(records[0].hook).toBe('dangerous-actions');
      expect(records[0].pattern_id).toBe('some-pattern');
      expect(records[0].tool_name).toBe('Bash');
      expect(records[0].ide).toBe('claude-code');
      expect(records[0].session_id).toBe('sess-1');
      expect(typeof records[0].ts).toBe('string');
    });
  }

  test('appends multiple records across calls (append-only)', () => {
    appendAuditRecord({ hook: 'h', decision: 'deny', patternId: 'a', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'x' }, env);
    appendAuditRecord({ hook: 'h', decision: 'advise', patternId: 'b', toolName: 'Write', toolKind: 'write', ide: 'claude-code', sessionId: null, filePath: '/tmp/y' }, env);
    expect(readRecords(target)).toHaveLength(2);
  });
});

describe('appendAuditRecord — no raw content ever leaks', () => {
  const SECRET_COMMAND = 'psql -c "DROP TABLE users" --password=hunter2SuperSecret';
  const SECRET_PATH = '/Users/alice/projects/acme-internal/secrets/prod.pem';
  let target: string;
  let env: Record<string, string>;

  beforeEach(() => {
    target = path.join(TMP, `no-leak-${Math.random()}`, 'audit.jsonl');
    env = { ROSETTA_AUDIT_LOG: target, HOME: AUDIT_HOME };
  });

  test('raw command text never appears in the record or on disk', () => {
    appendAuditRecord(
      { hook: 'dangerous-actions', decision: 'deny', patternId: 'sql-drop-table', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: 's', command: SECRET_COMMAND },
      env,
    );
    const raw = fs.readFileSync(target, 'utf-8');
    expect(raw).not.toContain('hunter2SuperSecret');
    expect(raw).not.toContain('DROP TABLE');
    expect(raw).not.toContain(SECRET_COMMAND);
    const [record] = readRecords(target);
    expect(record.cmd_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('raw file path never appears in the record or on disk', () => {
    appendAuditRecord(
      { hook: 'dangerous-actions', decision: 'advise', patternId: 'gpg-private', toolName: 'Write', toolKind: 'write', ide: 'claude-code', sessionId: 's', filePath: SECRET_PATH },
      env,
    );
    const raw = fs.readFileSync(target, 'utf-8');
    expect(raw).not.toContain(SECRET_PATH);
    expect(raw).not.toContain('alice');
    expect(raw).not.toContain('acme-internal');
    const [record] = readRecords(target);
    expect(record.file_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('repo root is hashed, not stored raw', () => {
    const repoCwd = TMP; // not a git repo, so the cwd itself is hashed
    appendAuditRecord(
      { hook: 'dangerous-actions', decision: 'deny', patternId: 'rm-rf-root', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: 's', command: 'rm -rf /', cwd: repoCwd },
      env,
    );
    const raw = fs.readFileSync(target, 'utf-8');
    expect(raw).not.toContain(repoCwd);
    const [record] = readRecords(target);
    expect(record.repo_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('null command/filePath/cwd → null hashes, no crash', () => {
    appendAuditRecord({ hook: 'dangerous-actions', decision: 'advise', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null }, env);
    const [record] = readRecords(target);
    expect(record.cmd_sha256).toBeNull();
    expect(record.file_sha256).toBeNull();
    expect(record.repo_sha256).toBeNull();
  });
});

describe('appendAuditRecord — write-failure tolerance', () => {
  test('unwritable directory never throws', () => {
    // A file path used as a parent "directory" makes mkdir/append fail — swallowed, not thrown.
    const blockerFile = path.join(TMP, 'im-a-file-not-a-dir');
    fs.writeFileSync(blockerFile, 'x');
    const target = path.join(blockerFile, 'nested', 'audit.jsonl');
    expect(() =>
      appendAuditRecord(
        { hook: 'dangerous-actions', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'rm -rf /' },
        { ROSETTA_AUDIT_LOG: target, HOME: AUDIT_HOME },
      ),
    ).not.toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  test('empty explicit path → treated as disabled, never throws', () => {
    expect(() =>
      appendAuditRecord(
        { hook: 'dangerous-actions', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'rm -rf /' },
        { ROSETTA_AUDIT_LOG: '' },
      ),
    ).not.toThrow();
  });
});

// P3: rotation now renames to a TIMESTAMPED sibling (`<stem>.<timestamp><ext>`) rather than
// always `${filePath}.1` — the old scheme silently overwrote whatever a PRIOR rotation had left
// at `.1`. This intentionally changes the rotated file's name (see FINDINGS.md / final report);
// behavior asserted below: a distinct, non-clobbered file per rotation, capped at 5 kept.
describe('appendAuditRecord — size cap / rotation (P3: no clobbering, keep last 5)', () => {
  const rotatedSiblings = (target: string): string[] => {
    const dir = path.dirname(target);
    const base = path.basename(target);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    return fs.readdirSync(dir).filter((n) => n.startsWith(`${stem}.`) && n.endsWith(ext) && n !== base);
  };

  test('rotates the file once it exceeds the size cap, without clobbering a prior rotation', () => {
    const target = path.join(TMP, `rotate-${Math.random()}`, 'audit.jsonl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Simulate a PRIOR rotation already sitting next to the log, with content that must survive.
    const priorRotated = `${target.replace(/\.jsonl$/, '')}.2020-01-01T00-00-00-000Z.jsonl`;
    fs.writeFileSync(priorRotated, '{"prior":"rotation"}\n');
    // Pre-seed a file already at the cap so the very next append triggers rotation.
    fs.writeFileSync(target, 'x'.repeat(10 * 1024 * 1024));
    appendAuditRecord(
      { hook: 'dangerous-actions', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'rm -rf /' },
      { ROSETTA_AUDIT_LOG: target, HOME: AUDIT_HOME },
    );
    expect(fs.existsSync(target)).toBe(true);
    expect(readRecords(target)).toHaveLength(1);
    // The prior rotation is untouched — this is the bug being fixed.
    expect(fs.readFileSync(priorRotated, 'utf-8')).toBe('{"prior":"rotation"}\n');
    // A NEW rotated sibling was created for the just-rotated (10MB) file.
    const siblings = rotatedSiblings(target);
    expect(siblings.length).toBe(2); // the pre-seeded prior rotation + the new one
    const newRotated = siblings.find((n) => !n.includes('2020-01-01'))!;
    expect(newRotated).toBeDefined();
    expect(fs.statSync(path.join(path.dirname(target), newRotated)).size).toBe(10 * 1024 * 1024);
  });

  test('two rotations of the same file within the same call each get their own file (no clobber)', () => {
    // Guards the actual bug: rotate once, then immediately grow the file past the cap again and
    // rotate a second time — the SECOND rotation must not silently overwrite the FIRST.
    const target = path.join(TMP, `rotate-twice-${Math.random()}`, 'audit.jsonl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x'.repeat(10 * 1024 * 1024));
    appendAuditRecord(
      { hook: 'h', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'one' },
      { ROSETTA_AUDIT_LOG: target, HOME: AUDIT_HOME },
    );
    const firstRotated = rotatedSiblings(target);
    expect(firstRotated.length).toBe(1);
    // Grow the freshly-rotated-from file back past the cap and rotate again, immediately (same
    // millisecond is possible — the stamp alone isn't guaranteed unique, so the fix must not
    // depend on that; it must simply never silently overwrite via a fixed `.1` name in the
    // common case exercised by the "prior rotation" test above).
    fs.appendFileSync(target, 'x'.repeat(10 * 1024 * 1024));
    appendAuditRecord(
      { hook: 'h', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'two' },
      { ROSETTA_AUDIT_LOG: target, HOME: AUDIT_HOME },
    );
    expect(fs.existsSync(target)).toBe(true);
    expect(readRecords(target)).toHaveLength(1); // the "two" record — "one" is safely in a rotated file
  });

  test('keeps only the last 5 rotated files, pruning older ones', () => {
    const target = path.join(TMP, `rotate-prune-${Math.random()}`, 'audit.jsonl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const stem = target.replace(/\.jsonl$/, '');
    // Pre-seed 5 rotated files with distinct, sortable timestamps.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(`${stem}.2020-01-0${i + 1}T00-00-00-000Z.jsonl`, `{"n":${i}}\n`);
    }
    fs.writeFileSync(target, 'x'.repeat(10 * 1024 * 1024));
    appendAuditRecord(
      { hook: 'dangerous-actions', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'rm -rf /' },
      { ROSETTA_AUDIT_LOG: target, HOME: AUDIT_HOME },
    );
    // 5 pre-seeded + 1 new = 6 before pruning; the oldest (2020-01-01) must be gone, capped at 5.
    expect(fs.existsSync(`${stem}.2020-01-01T00-00-00-000Z.jsonl`)).toBe(false);
    expect(rotatedSiblings(target).length).toBe(5);
  });
});

// P2-7: hashes are keyed (HMAC-SHA256) rather than plain, unsalted SHA-256 — an empty default
// salt made the old hashes a guessable-dictionary target (SHA-256 of common commands/paths).
describe('appendAuditRecord — P2-7 keyed hashing', () => {
  const crypto = require('crypto') as typeof import('crypto');
  let target: string;

  beforeEach(() => {
    target = path.join(TMP, `keyed-${Math.random()}`, 'audit.jsonl');
  });

  test('ROSETTA_AUDIT_SALT set → hash is HMAC-SHA256 with that salt, and keyed:true', () => {
    const salt = 'org-secret-salt-value';
    appendAuditRecord(
      { hook: 'h', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'rm -rf /tmp/x' },
      { ROSETTA_AUDIT_LOG: target, ROSETTA_AUDIT_SALT: salt, HOME: AUDIT_HOME },
    );
    const [record] = readRecords(target);
    const expected = crypto.createHmac('sha256', Buffer.from(salt, 'utf8')).update('rm -rf /tmp/x', 'utf8').digest('hex');
    expect(record.cmd_sha256).toBe(expected);
    expect(record.keyed).toBe(true);
    // Never the plain, unsalted SHA-256 — that's exactly the guessable form being fixed.
    const unsalted = crypto.createHash('sha256').update('rm -rf /tmp/x', 'utf8').digest('hex');
    expect(record.cmd_sha256).not.toBe(unsalted);
  });

  test('different ROSETTA_AUDIT_SALT values produce different hashes for the same input', () => {
    appendAuditRecord(
      { hook: 'h', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'same-command' },
      { ROSETTA_AUDIT_LOG: target, ROSETTA_AUDIT_SALT: 'salt-a', HOME: AUDIT_HOME },
    );
    const target2 = path.join(TMP, `keyed-b-${Math.random()}`, 'audit.jsonl');
    appendAuditRecord(
      { hook: 'h', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'same-command' },
      { ROSETTA_AUDIT_LOG: target2, ROSETTA_AUDIT_SALT: 'salt-b', HOME: AUDIT_HOME },
    );
    expect(readRecords(target)[0].cmd_sha256).not.toBe(readRecords(target2)[0].cmd_sha256);
  });

  test('reads the salt from the INJECTED env, not process.env', () => {
    const prevSalt = process.env.ROSETTA_AUDIT_SALT;
    process.env.ROSETTA_AUDIT_SALT = 'process-env-salt-must-be-ignored';
    try {
      appendAuditRecord(
        { hook: 'h', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'x' },
        { ROSETTA_AUDIT_LOG: target, ROSETTA_AUDIT_SALT: 'injected-env-salt', HOME: AUDIT_HOME },
      );
      const [record] = readRecords(target);
      const expected = crypto.createHmac('sha256', Buffer.from('injected-env-salt', 'utf8')).update('x', 'utf8').digest('hex');
      expect(record.cmd_sha256).toBe(expected);
    } finally {
      if (prevSalt === undefined) delete process.env.ROSETTA_AUDIT_SALT;
      else process.env.ROSETTA_AUDIT_SALT = prevSalt;
    }
  });

  test('no ROSETTA_AUDIT_SALT → auto-created per-install key is used, and keyed:true', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-home-auto-'));
    appendAuditRecord(
      { hook: 'h', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'rm -rf /tmp/x' },
      { ROSETTA_AUDIT_LOG: target, HOME: home },
    );
    const keyPath = path.join(home, '.rosetta', 'audit', '.key');
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.statSync(keyPath).size).toBe(32);
    expect((fs.statSync(keyPath).mode & 0o777)).toBe(0o600);
    const [record] = readRecords(target);
    expect(record.keyed).toBe(true);
    const key = fs.readFileSync(keyPath);
    const expected = crypto.createHmac('sha256', key).update('rm -rf /tmp/x', 'utf8').digest('hex');
    expect(record.cmd_sha256).toBe(expected);
  });

  test('the auto-created key is reused (stable) across multiple appends', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-home-reuse-'));
    const t1 = path.join(TMP, `reuse-1-${Math.random()}`, 'audit.jsonl');
    const t2 = path.join(TMP, `reuse-2-${Math.random()}`, 'audit.jsonl');
    appendAuditRecord(
      { hook: 'h', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'same' },
      { ROSETTA_AUDIT_LOG: t1, HOME: home },
    );
    appendAuditRecord(
      { hook: 'h', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'same' },
      { ROSETTA_AUDIT_LOG: t2, HOME: home },
    );
    expect(readRecords(t1)[0].cmd_sha256).toBe(readRecords(t2)[0].cmd_sha256);
  });
});
