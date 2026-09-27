import { describe, test, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendAuditRecord, resolveAuditConfig } from '../../src/runtime/audit';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));

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
    env = { ROSETTA_AUDIT_LOG: target };
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
    env = { ROSETTA_AUDIT_LOG: target };
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
        { ROSETTA_AUDIT_LOG: target },
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

describe('appendAuditRecord — size cap / rotation', () => {
  test('rotates the file once it exceeds the size cap', () => {
    const target = path.join(TMP, `rotate-${Math.random()}`, 'audit.jsonl');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Pre-seed a file already at the cap so the very next append triggers rotation.
    fs.writeFileSync(target, 'x'.repeat(10 * 1024 * 1024));
    appendAuditRecord(
      { hook: 'dangerous-actions', decision: 'deny', patternId: 'p', toolName: 'Bash', toolKind: 'bash', ide: 'claude-code', sessionId: null, command: 'rm -rf /' },
      { ROSETTA_AUDIT_LOG: target },
    );
    expect(fs.existsSync(`${target}.1`)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(readRecords(target)).toHaveLength(1);
  });
});
