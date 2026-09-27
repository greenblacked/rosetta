import type Anthropic from '@anthropic-ai/sdk';
import { createLimiter, withRetry } from './runner.js';
import { computeCostUsd } from './pricing.js';
import type { RouteAttemptResult, RouteCaseConfig, RouteConfig, RouteTarget, RouteTargetKind } from './types.js';

const SELECT_TOOL_NAME = 'select_route';

function targetKey(kind: RouteTargetKind, name: string): string {
  return `${kind}:${name}`;
}

function buildSystemPrompt(rosettaSkillBody: string | null, targets: RouteTarget[]): string {
  const lines: string[] = [];
  if (rosettaSkillBody) {
    lines.push(
      'You are the Rosetta router. This is the `rosetta` skill definition you follow:',
      rosettaSkillBody,
      '',
    );
  } else {
    lines.push('You are a router that selects the single best-matching skill or workflow for a user request.', '');
  }
  lines.push('Available routing targets (kind: name — description):');
  for (const target of targets) {
    lines.push(`- ${target.kind}: ${target.name} — ${target.description}`);
  }
  lines.push(
    '',
    'Call the select_route tool exactly once with the single best-matching target. ' +
      'Do not explain your choice in text; the tool call is the only output that is scored.',
  );
  return lines.join('\n');
}

function buildSelectTool(targets: RouteTarget[]): Anthropic.Tool {
  return {
    name: SELECT_TOOL_NAME,
    description: 'Select the single best-matching skill or workflow for the user request.',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'The selected routing target, exactly as "kind:name" from the available list.',
          enum: targets.map((target) => targetKey(target.kind, target.name)),
        },
      },
      required: ['target'],
    },
  };
}

/** No LLM judge: correctness is decided purely from the forced tool call's structured input, never
 * from parsing free-form text. */
function parseSelection(response: Anthropic.Message): { kind: RouteTargetKind; name: string } | null {
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === SELECT_TOOL_NAME,
  );
  if (!toolUse) return null;
  const rawTarget = (toolUse.input as { target?: unknown } | undefined)?.target;
  if (typeof rawTarget !== 'string') return null;
  const sep = rawTarget.indexOf(':');
  if (sep < 0) return null;
  const kind = rawTarget.slice(0, sep);
  const name = rawTarget.slice(sep + 1);
  if ((kind !== 'skill' && kind !== 'workflow') || !name) return null;
  return { kind, name };
}

async function runAttempt(
  client: Anthropic,
  model: string,
  system: string,
  tool: Anthropic.Tool,
  routeCase: RouteCaseConfig,
  repetition: number,
): Promise<RouteAttemptResult> {
  const start = Date.now();
  try {
    const response = await withRetry(() =>
      client.messages
        .stream({
          model,
          max_tokens: 256,
          // Routing is a forced classification call, not deliberation; disabling thinking keeps the
          // tool call deterministic-ish and leaves the full budget for the (tiny) structured output.
          thinking: { type: 'disabled' },
          system,
          tools: [tool],
          tool_choice: { type: 'tool', name: SELECT_TOOL_NAME },
          messages: [{ role: 'user', content: routeCase.prompt }],
        })
        .finalMessage(),
    );
    const latencyMs = Date.now() - start;
    const actual = parseSelection(response);
    const correct = !!actual && actual.kind === routeCase.expect.kind && actual.name === routeCase.expect.name;
    return {
      caseId: routeCase.id,
      repetition,
      prompt: routeCase.prompt,
      expected: routeCase.expect,
      actual,
      correct,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd: computeCostUsd(response.usage.input_tokens, response.usage.output_tokens, model),
    };
  } catch (err) {
    return {
      caseId: routeCase.id,
      repetition,
      prompt: routeCase.prompt,
      expected: routeCase.expect,
      actual: null,
      correct: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    };
  }
}

export type RouteProgressCallback = (done: number, total: number, attempt: RouteAttemptResult) => void;

/** Runs every (case, repetition) as an independent forced-tool-call request under one shared
 * concurrency limit, reusing the bench runner's retry/streaming/limiter primitives. Never rejects:
 * a failed attempt (after retries) is recorded with `error` and scored as incorrect. */
export async function runRouteEval(
  client: Anthropic,
  config: RouteConfig,
  targets: RouteTarget[],
  rosettaSkillBody: string | null,
  onProgress?: RouteProgressCallback,
): Promise<RouteAttemptResult[]> {
  const system = buildSystemPrompt(rosettaSkillBody, targets);
  const tool = buildSelectTool(targets);
  const limit = createLimiter(Math.max(1, config.concurrency));
  const total = config.cases.length * config.repetitions;
  let completed = 0;

  const promises: Array<Promise<RouteAttemptResult>> = [];
  for (const routeCase of config.cases) {
    for (let repetition = 0; repetition < config.repetitions; repetition++) {
      promises.push(
        limit(async () => {
          const attempt = await runAttempt(client, config.model, system, tool, routeCase, repetition);
          completed++;
          onProgress?.(completed, total, attempt);
          return attempt;
        }),
      );
    }
  }
  return Promise.all(promises);
}
