import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { RouteConfig, RouteTarget } from './types.js';

function formatZodError(err: z.ZodError): string {
  const issues = err.issues
    .map((issue) => `  - ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
  return `Routing config is invalid:\n${issues}`;
}

const routeExpectSchema = z.object({
  kind: z.enum(['skill', 'workflow']),
  name: z.string().min(1),
});

const routeCaseSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  expect: routeExpectSchema,
  forbid: z.array(z.string().min(1)).optional(),
});

const routeConfigSchema = z.object({
  // Small model tier by default (F2-5): routing is a forced single-tool-call classification task,
  // not generation, so a small/cheap model suffices and keeps eval cost near-zero.
  model: z.string().min(1).default('claude-haiku-4-5'),
  repetitions: z.number().int().positive().default(1),
  concurrency: z.number().int().positive().default(5),
  cases: z.array(routeCaseSchema).min(1),
});

export function parseRouteConfig(raw: unknown): RouteConfig {
  const result = routeConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }
  const parsed = result.data;
  const ids = new Set<string>();
  for (const routeCase of parsed.cases) {
    if (ids.has(routeCase.id)) {
      throw new Error(`Duplicate routing case id "${routeCase.id}".`);
    }
    ids.add(routeCase.id);
  }
  return parsed;
}

export function loadRouteConfig(configPath: string): RouteConfig {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Routing config file not found: ${configPath}\nPass --config <path>.`);
    }
    throw new Error(`Could not read routing config file ${configPath}: ${(err as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Routing config file is not valid JSON: ${configPath}\n  ${(err as Error).message}`);
  }

  return parseRouteConfig(raw);
}

/** Cross-checks case expectations against the resolved router context: catches typos (an `expect`
 * that names no known skill/workflow) before any API call is made. Separate from schema validation
 * so `parseRouteConfig`/`loadRouteConfig` stay context-independent, like `evals.json`'s validation. */
export function validateCasesAgainstTargets(config: RouteConfig, targets: RouteTarget[]): void {
  const known = new Set(targets.map((t) => `${t.kind}:${t.name}`));
  const unknown = config.cases
    .map((routeCase) => ({ id: routeCase.id, key: `${routeCase.expect.kind}:${routeCase.expect.name}` }))
    .filter(({ key }) => !known.has(key));
  if (unknown.length > 0) {
    const list = unknown.map(({ id, key }) => `  - case "${id}": expect "${key}" is not a known target`).join('\n');
    throw new Error(
      `Routing config references unknown targets (not found in the resolved context):\n${list}\n` +
        `Known targets: ${[...known].sort().join(', ') || '(none)'}`,
    );
  }
}
