import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { parseRouteConfig, loadRouteConfig, validateCasesAgainstTargets } from '../src/route-config.js';
import { loadRouterContext } from '../src/route-context.js';
import { runRouteEval } from '../src/route-runner.js';
import { buildRouteReport, compareToBaseline, renderRouteMarkdownReport } from '../src/route-report.js';
import type { RouteConfig, RouteTarget } from '../src/types.js';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mktemp();
  tmpDirs.push(dir);
  return dir;
}
function mktemp(): string {
  return mkdtempSync(path.join(tmpdir(), 'rosettify-route-'));
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string, frontmatterExtra: string, description = `About ${name}`): void {
  const skillDir = path.join(dir, 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${frontmatterExtra}\n---\n\nBody of ${name}.\n`,
  );
}

function writeWorkflow(dir: string, name: string, frontmatterExtra: string, description = `About ${name}`): void {
  const workflowsDir = path.join(dir, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(
    path.join(workflowsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n${frontmatterExtra}\n---\n\nBody of ${name}.\n`,
  );
}

function buildFixtureContext(): string {
  const dir = makeTmpDir();
  writeSkill(dir, 'rosetta', 'disable-model-invocation: true', 'Routes requests');
  writeSkill(dir, 'planning', '');
  writeSkill(dir, 'debugging', '');
  writeSkill(dir, 'hidden-subskill', 'disable-model-invocation: true');
  writeWorkflow(dir, 'coding-flow', 'tags: ["workflow"]');
  writeWorkflow(dir, 'testgen-flow', 'tags: ["workflow"]');
  writeWorkflow(dir, 'testgen-flow-question-generation', 'disable-model-invocation: true\nuser-invocable: false');
  return dir;
}

function minimalRouteConfig(overrides: Partial<RouteConfig> = {}): unknown {
  return {
    cases: [
      { id: 'c1', prompt: 'fix a bug please', expect: { kind: 'workflow', name: 'coding-flow' } },
    ],
    ...overrides,
  };
}

describe('route-context: loadRouterContext', () => {
  it('extracts the rosetta skill body separately and excludes it from targets', () => {
    const dir = buildFixtureContext();
    const ctx = loadRouterContext(dir);
    expect(ctx.rosettaSkillBody).toContain('Body of rosetta.');
    expect(ctx.targets.find((t) => t.name === 'rosetta')).toBeUndefined();
  });

  it('excludes skills with disable-model-invocation: true and includes routable ones', () => {
    const dir = buildFixtureContext();
    const ctx = loadRouterContext(dir);
    const skillNames = ctx.targets.filter((t) => t.kind === 'skill').map((t) => t.name);
    expect(skillNames).toEqual(['debugging', 'planning']);
    expect(skillNames).not.toContain('hidden-subskill');
  });

  it('includes only top-level workflows tagged "workflow", excluding phase files', () => {
    const dir = buildFixtureContext();
    const ctx = loadRouterContext(dir);
    const workflowNames = ctx.targets.filter((t) => t.kind === 'workflow').map((t) => t.name);
    expect(workflowNames).toEqual(['coding-flow', 'testgen-flow']);
    expect(workflowNames).not.toContain('testgen-flow-question-generation');
  });

  it('throws when the context directory does not exist', () => {
    expect(() => loadRouterContext('/nonexistent/path/xyz')).toThrow(/not found/);
  });

  it('throws when no routable targets are found', () => {
    const dir = makeTmpDir();
    mkdirSync(path.join(dir, 'skills'), { recursive: true });
    expect(() => loadRouterContext(dir)).toThrow(/No routable/);
  });
});

describe('route-config: parseRouteConfig / loadRouteConfig', () => {
  it('applies defaults for a minimal config', () => {
    const config = parseRouteConfig(minimalRouteConfig());
    expect(config.model).toBe('claude-haiku-4-5');
    expect(config.repetitions).toBe(1);
    expect(config.concurrency).toBe(5);
    expect(config.cases).toHaveLength(1);
  });

  it('rejects a config with no cases', () => {
    expect(() => parseRouteConfig({ cases: [] })).toThrow(/Routing config is invalid/);
  });

  it('rejects an unknown expect.kind', () => {
    expect(() =>
      parseRouteConfig(
        minimalRouteConfig({
          cases: [{ id: 'c1', prompt: 'x', expect: { kind: 'agent', name: 'foo' } }] as never,
        }),
      ),
    ).toThrow(/Routing config is invalid/);
  });

  it('rejects duplicate case ids', () => {
    expect(() =>
      parseRouteConfig({
        cases: [
          { id: 'dup', prompt: 'a', expect: { kind: 'workflow', name: 'coding-flow' } },
          { id: 'dup', prompt: 'b', expect: { kind: 'workflow', name: 'testgen-flow' } },
        ],
      }),
    ).toThrow(/Duplicate routing case id "dup"/);
  });

  it('rejects a case with an empty prompt', () => {
    expect(() =>
      parseRouteConfig({
        cases: [{ id: 'c1', prompt: '', expect: { kind: 'workflow', name: 'coding-flow' } }],
      }),
    ).toThrow(/Routing config is invalid/);
  });

  it('loadRouteConfig reports a clear error for a missing file', () => {
    expect(() => loadRouteConfig('/nonexistent/routes.json')).toThrow(/Routing config file not found/);
  });

  it('loadRouteConfig reports a clear error for invalid JSON', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'routes.json');
    writeFileSync(file, '{ not json');
    expect(() => loadRouteConfig(file)).toThrow(/not valid JSON/);
  });

  it('loadRouteConfig reads and parses a valid file from disk', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'routes.json');
    writeFileSync(file, JSON.stringify(minimalRouteConfig()));
    const config = loadRouteConfig(file);
    expect(config.cases[0].id).toBe('c1');
  });
});

describe('route-config: validateCasesAgainstTargets', () => {
  const targets: RouteTarget[] = [
    { kind: 'workflow', name: 'coding-flow', description: 'd' },
    { kind: 'skill', name: 'planning', description: 'd' },
  ];

  it('passes when every case expectation matches a known target', () => {
    const config = parseRouteConfig(minimalRouteConfig());
    expect(() => validateCasesAgainstTargets(config, targets)).not.toThrow();
  });

  it('throws listing every case with an unknown target (e.g. a typo)', () => {
    const config = parseRouteConfig(
      minimalRouteConfig({
        cases: [
          { id: 'typo-case', prompt: 'x', expect: { kind: 'workflow', name: 'codnig-flow' } },
          { id: 'wrong-kind', prompt: 'y', expect: { kind: 'skill', name: 'coding-flow' } },
        ],
      }),
    );
    expect(() => validateCasesAgainstTargets(config, targets)).toThrow(/typo-case/);
    expect(() => validateCasesAgainstTargets(config, targets)).toThrow(/wrong-kind/);
  });
});

// The `select_route` forced tool call shape: fakes here expose `stream()`, matching the bench
// runner's convention (`.stream(params).finalMessage()`), never `.create()`.
function fakeMessages(handler: (params: Anthropic.MessageStreamParams) => Promise<unknown>): {
  stream: (params: Anthropic.MessageStreamParams) => { finalMessage: () => Promise<unknown> };
} {
  return {
    stream: (params: Anthropic.MessageStreamParams) => ({ finalMessage: () => handler(params) }),
  };
}

function toolResponse(target: string, usage = { input_tokens: 10, output_tokens: 5 }): unknown {
  return {
    content: [{ type: 'tool_use', id: 'tu_1', name: 'select_route', input: { target } }],
    usage,
    stop_reason: 'tool_use',
  };
}

const TARGETS: RouteTarget[] = [
  { kind: 'workflow', name: 'coding-flow', description: 'coding' },
  { kind: 'workflow', name: 'testgen-flow', description: 'testgen' },
  { kind: 'skill', name: 'planning', description: 'planning' },
];

describe('route-runner: runRouteEval', () => {
  it('sends a forced tool_choice call with an enum of exactly the given target keys', async () => {
    const seen: Anthropic.MessageStreamParams[] = [];
    const client = {
      messages: fakeMessages(async (params) => {
        seen.push(params);
        return toolResponse('workflow:coding-flow');
      }),
    } as unknown as Anthropic;

    const config = parseRouteConfig(minimalRouteConfig());
    await runRouteEval(client, config, TARGETS, 'router persona text');

    expect(seen).toHaveLength(1);
    const request = seen[0] as unknown as {
      tool_choice: { type: string; name: string };
      tools: Array<{ name: string; input_schema: { properties: { target: { enum: string[] } } } }>;
      thinking: { type: string };
      system: string;
    };
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'select_route' });
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0].name).toBe('select_route');
    expect(request.tools[0].input_schema.properties.target.enum).toEqual([
      'workflow:coding-flow',
      'workflow:testgen-flow',
      'skill:planning',
    ]);
    expect(request.thinking).toEqual({ type: 'disabled' });
    expect(request.system).toContain('router persona text');
    expect(request.system).toContain('workflow: coding-flow — coding');
  });

  it('scores a correct selection and records token/cost totals', async () => {
    const client = {
      messages: fakeMessages(async () => toolResponse('workflow:coding-flow', { input_tokens: 20, output_tokens: 8 })),
    } as unknown as Anthropic;
    const config = parseRouteConfig(minimalRouteConfig());

    const [attempt] = await runRouteEval(client, config, TARGETS, null);

    expect(attempt.correct).toBe(true);
    expect(attempt.actual).toEqual({ kind: 'workflow', name: 'coding-flow' });
    expect(attempt.inputTokens).toBe(20);
    expect(attempt.outputTokens).toBe(8);
    expect(attempt.costUsd).toBeGreaterThan(0);
    expect(attempt.error).toBeUndefined();
  });

  it('scores a wrong selection as incorrect without throwing', async () => {
    const client = {
      messages: fakeMessages(async () => toolResponse('skill:planning')),
    } as unknown as Anthropic;
    const config = parseRouteConfig(minimalRouteConfig());

    const [attempt] = await runRouteEval(client, config, TARGETS, null);

    expect(attempt.correct).toBe(false);
    expect(attempt.actual).toEqual({ kind: 'skill', name: 'planning' });
  });

  it('treats a missing tool_use block as an incorrect attempt with a null actual', async () => {
    const client = {
      messages: fakeMessages(async () => ({
        content: [{ type: 'text', text: 'I refuse to call the tool.' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      })),
    } as unknown as Anthropic;
    const config = parseRouteConfig(minimalRouteConfig());

    const [attempt] = await runRouteEval(client, config, TARGETS, null);

    expect(attempt.correct).toBe(false);
    expect(attempt.actual).toBeNull();
    expect(attempt.error).toBeUndefined();
  });

  it('isolates a failed API call as an error attempt without failing the batch', async () => {
    const client = {
      messages: fakeMessages(async () => {
        throw Object.assign(new Error('bad request'), { status: 400 }); // non-retryable
      }),
    } as unknown as Anthropic;
    const config = parseRouteConfig(minimalRouteConfig());

    const [attempt] = await runRouteEval(client, config, TARGETS, null);

    expect(attempt.correct).toBe(false);
    expect(attempt.error).toMatch(/bad request/);
  });

  it('runs `repetitions` attempts per case', async () => {
    let calls = 0;
    const client = {
      messages: fakeMessages(async () => {
        calls++;
        return toolResponse('workflow:coding-flow');
      }),
    } as unknown as Anthropic;
    const config = parseRouteConfig(minimalRouteConfig({ repetitions: 3, concurrency: 2 } as never));

    const attempts = await runRouteEval(client, config, TARGETS, null);

    expect(calls).toBe(3);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.repetition).sort()).toEqual([0, 1, 2]);
  });
});

describe('route-report: buildRouteReport', () => {
  it('computes overall accuracy, per-case accuracy, and a confusion matrix', () => {
    const attempts = [
      {
        caseId: 'c1',
        repetition: 0,
        prompt: 'p1',
        expected: { kind: 'workflow' as const, name: 'coding-flow' },
        actual: { kind: 'workflow' as const, name: 'coding-flow' },
        correct: true,
        latencyMs: 10,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.001,
      },
      {
        caseId: 'c2',
        repetition: 0,
        prompt: 'p2',
        expected: { kind: 'workflow' as const, name: 'testgen-flow' },
        actual: { kind: 'workflow' as const, name: 'coding-flow' },
        correct: false,
        latencyMs: 10,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.001,
      },
      {
        caseId: 'c2',
        repetition: 1,
        prompt: 'p2',
        expected: { kind: 'workflow' as const, name: 'testgen-flow' },
        actual: null,
        correct: false,
        error: 'boom',
        latencyMs: 10,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
      },
    ];

    const report = buildRouteReport('plugins/core-claude', 'claude-haiku-4-5', TARGETS, attempts);

    expect(report.totalAttempts).toBe(3);
    expect(report.correctAttempts).toBe(1);
    expect(report.accuracy).toBeCloseTo(1 / 3);

    const c1 = report.cases.find((c) => c.caseId === 'c1')!;
    expect(c1.accuracy).toBe(1);
    const c2 = report.cases.find((c) => c.caseId === 'c2')!;
    expect(c2.accuracy).toBe(0);
    expect(c2.actualBreakdown).toEqual({ 'workflow:coding-flow': 1, '(error)': 1 });

    // Confusion matrix: two attempts expected testgen-flow but one landed on coding-flow, one errored.
    const testgenToCoding = report.confusionMatrix.find(
      (e) => e.expectedKey === 'workflow:testgen-flow' && e.actualKey === 'workflow:coding-flow',
    );
    expect(testgenToCoding?.count).toBe(1);
    const testgenToError = report.confusionMatrix.find(
      (e) => e.expectedKey === 'workflow:testgen-flow' && e.actualKey === '(error)',
    );
    expect(testgenToError?.count).toBe(1);
  });

  it('renders a markdown report with accuracy, per-case table, and confusion matrix sections', () => {
    const attempts = [
      {
        caseId: 'c1',
        repetition: 0,
        prompt: 'p1',
        expected: { kind: 'workflow' as const, name: 'coding-flow' },
        actual: { kind: 'workflow' as const, name: 'coding-flow' },
        correct: true,
        latencyMs: 10,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.001,
      },
    ];
    const report = buildRouteReport('plugins/core-claude', 'claude-haiku-4-5', TARGETS, attempts);
    const md = renderRouteMarkdownReport(report);
    expect(md).toContain('# rosettify-prompts route report');
    expect(md).toContain('## Accuracy');
    expect(md).toContain('## Per-case results');
    expect(md).toContain('## Confusion matrix');
    expect(md).toContain('100.0%');
  });
});

describe('route-report: compareToBaseline', () => {
  function reportWithAccuracy(accuracy: number) {
    return buildRouteReport(
      'plugins/core-claude',
      'claude-haiku-4-5',
      TARGETS,
      Array.from({ length: 10 }, (_, i) => ({
        caseId: `c${i}`,
        repetition: 0,
        prompt: 'p',
        expected: { kind: 'workflow' as const, name: 'coding-flow' },
        actual: i < accuracy * 10 ? { kind: 'workflow' as const, name: 'coding-flow' } : { kind: 'workflow' as const, name: 'testgen-flow' },
        correct: i < accuracy * 10,
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.0001,
      })),
    );
  }

  it('flags a regression when accuracy drops more than the allowed threshold', () => {
    const dir = makeTmpDir();
    const baselinePath = path.join(dir, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify(reportWithAccuracy(0.9)));

    const candidate = reportWithAccuracy(0.7);
    const compared = compareToBaseline(candidate, baselinePath, 5);

    expect(compared.baseline?.regression).toBe(true);
    expect(compared.baseline?.delta).toBeCloseTo(-20, 5);
  });

  it('does not flag a regression within the allowed threshold', () => {
    const dir = makeTmpDir();
    const baselinePath = path.join(dir, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify(reportWithAccuracy(0.9)));

    const candidate = reportWithAccuracy(0.88);
    const compared = compareToBaseline(candidate, baselinePath, 5);

    expect(compared.baseline?.regression).toBe(false);
  });

  it('throws a clear error when the baseline file is missing', () => {
    const candidate = reportWithAccuracy(0.9);
    expect(() => compareToBaseline(candidate, '/nonexistent/baseline.json', 5)).toThrow(/Could not read baseline/);
  });

  it('throws a clear error when the baseline file has no numeric accuracy field', () => {
    const dir = makeTmpDir();
    const baselinePath = path.join(dir, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify({ notAReport: true }));
    const candidate = reportWithAccuracy(0.9);
    expect(() => compareToBaseline(candidate, baselinePath, 5)).toThrow(/no numeric "accuracy" field/);
  });
});
