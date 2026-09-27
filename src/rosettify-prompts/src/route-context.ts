import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RouteTarget } from './types.js';

export interface RouterContext {
  /** Body of the `rosetta` skill (the router persona/process), if present in the context dir.
   * `rosetta` itself is never a routable target — it IS the router. */
  rosettaSkillBody: string | null;
  targets: RouteTarget[];
}

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/** Minimal, dependency-free YAML-frontmatter reader. Rosetta instruction files use only flat
 * `key: value` / `key: "value"` / `key: ['a', 'b']` frontmatter (see instructions/r3/core), so a
 * line-based parser is sufficient and avoids pulling in a full YAML parser for this. */
function parseFrontmatter(text: string): Frontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const fieldMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!fieldMatch) continue;
    let value = fieldMatch[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[fieldMatch[1]] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

function isTrue(value: string | undefined): boolean {
  return value === 'true';
}

function isFalse(value: string | undefined): boolean {
  return value === 'false';
}

function loadSkillTargets(contextDir: string): { targets: RouteTarget[]; rosettaSkillBody: string | null } {
  const skillsDir = path.join(contextDir, 'skills');
  const targets: RouteTarget[] = [];
  let rosettaSkillBody: string | null = null;
  if (!existsSync(skillsDir)) return { targets, rosettaSkillBody };

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    const raw = readFileSync(skillPath, 'utf-8');
    const { fields, body } = parseFrontmatter(raw);
    const name = fields.name || entry.name;

    if (name === 'rosetta') {
      rosettaSkillBody = body.trim();
      continue;
    }
    // Skills the model cannot auto-invoke (disable-model-invocation: true, e.g. sub-skills only
    // reachable via USE SKILL FILE) are not valid routing targets for a top-level request.
    if (isTrue(fields['disable-model-invocation'])) continue;
    if (isFalse(fields['user-invocable'])) continue;
    if (!fields.description) continue;
    targets.push({ kind: 'skill', name, description: fields.description });
  }
  return { targets, rosettaSkillBody };
}

function loadWorkflowTargets(contextDir: string): RouteTarget[] {
  const workflowsDir = path.join(contextDir, 'workflows');
  const targets: RouteTarget[] = [];
  if (!existsSync(workflowsDir)) return targets;

  for (const file of readdirSync(workflowsDir)) {
    if (!file.endsWith('.md')) continue;
    const raw = readFileSync(path.join(workflowsDir, file), 'utf-8');
    const { fields } = parseFrontmatter(raw);
    // Only top-level, routable workflows carry tags: ["workflow"]; phase files (e.g.
    // "testgen-flow-question-generation.md") omit it and/or set disable-model-invocation /
    // user-invocable: false — excluded so the router only ever picks a real entry point.
    if (isTrue(fields['disable-model-invocation'])) continue;
    if (isFalse(fields['user-invocable'])) continue;
    if (!fields.tags || !fields.tags.includes('workflow')) continue;
    if (!fields.description) continue;
    const name = fields.name || path.basename(file, '.md');
    targets.push({ kind: 'workflow', name, description: fields.description });
  }
  return targets;
}

/** Resolves the router context from a plugin (`plugins/core-claude`) or instructions
 * (`instructions/r3/core`) directory — both share the same `skills/*\/SKILL.md` +
 * `workflows/*.md` shape. Returns the `rosetta` skill body (router persona) plus every routable
 * skill/workflow target (name + description), sorted for deterministic output. */
export function loadRouterContext(contextDir: string): RouterContext {
  if (!existsSync(contextDir)) {
    throw new Error(`Context directory not found: ${contextDir}`);
  }
  const { targets: skillTargets, rosettaSkillBody } = loadSkillTargets(contextDir);
  const workflowTargets = loadWorkflowTargets(contextDir);
  const targets = [...skillTargets, ...workflowTargets].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
  if (targets.length === 0) {
    throw new Error(
      `No routable skill or workflow targets found under ${contextDir}. ` +
        `Expected "${contextDir}/skills/*/SKILL.md" and/or "${contextDir}/workflows/*.md".`,
    );
  }
  return { rosettaSkillBody, targets };
}
