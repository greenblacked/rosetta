// Regression for #C3: a workflow/skill/agent source file's frontmatter `name` must match its own
// filename (or directory name, for skills) — Codex and Antigravity (Agent Skills spec) and Copilot
// (prompt slash-command) all identify a document by its `name`, so a mismatch produces a duplicate
// or unreachable identity once the plugin is generated (e.g. `coding-light-flow.md` shipping
// `name: coding-flow`, which collided with the real `coding-flow`).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { expectedNameStemFromFilename } from '../../../src/lint/name-consistency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const CORE_SOURCE = path.join(REPO_ROOT, 'instructions', 'r3', 'core');

function frontmatterName(filePath: string): string | undefined {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw.trimStart().startsWith('---')) return undefined;
  const parsed = matter(raw);
  const name = (parsed.data as Record<string, unknown>).name;
  return typeof name === 'string' ? name : undefined;
}

describe('source frontmatter name == filename/dirname (C3 regression)', () => {
  it('every workflow file frontmatter name matches its clean filename stem', () => {
    const dir = path.join(CORE_SOURCE, 'workflows');
    const mismatches: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const full = path.join(dir, entry.name);
      const name = frontmatterName(full);
      if (!name) continue;
      const expectedStem = expectedNameStemFromFilename(entry.name);
      if (name !== expectedStem) {
        mismatches.push(`${entry.name}: name="${name}" expected="${expectedStem}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every agent file frontmatter name matches its clean filename stem', () => {
    const dir = path.join(CORE_SOURCE, 'agents');
    const mismatches: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const full = path.join(dir, entry.name);
      const name = frontmatterName(full);
      if (!name) continue;
      const expectedStem = expectedNameStemFromFilename(entry.name);
      if (name !== expectedStem) {
        mismatches.push(`${entry.name}: name="${name}" expected="${expectedStem}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every skill SKILL.md frontmatter name matches its own directory name', () => {
    const dir = path.join(CORE_SOURCE, 'skills');
    const mismatches: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const name = frontmatterName(skillMd);
      if (!name) continue;
      if (name !== entry.name) {
        mismatches.push(`${entry.name}/SKILL.md: name="${name}" expected="${entry.name}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
