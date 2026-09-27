import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  RouteAttemptResult,
  RouteCaseSummary,
  RouteConfusionEntry,
  RouteReport,
  RouteTarget,
} from './types.js';

function targetKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

/** Stable hash of a sorted, de-duplicated set of case ids — used to flag a baseline run against a
 * different set of routing cases (compareToBaseline). Not a security boundary, just a cheap,
 * deterministic fingerprint. */
export function computeCaseIdsHash(caseIds: string[]): string {
  const sorted = [...new Set(caseIds)].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

export function buildRouteReport(
  contextDir: string,
  model: string,
  targets: RouteTarget[],
  attempts: RouteAttemptResult[],
  repetitions: number,
): RouteReport {
  const byCase = new Map<string, RouteAttemptResult[]>();
  for (const attempt of attempts) {
    const list = byCase.get(attempt.caseId) ?? [];
    list.push(attempt);
    byCase.set(attempt.caseId, list);
  }

  const cases: RouteCaseSummary[] = [];
  const confusionCounts = new Map<string, number>();
  let correctAttempts = 0;
  let erroredAttempts = 0;

  for (const [caseId, list] of byCase) {
    const expected = list[0].expected;
    const breakdown: Record<string, number> = {};
    let correct = 0;
    let errored = 0;
    let forbiddenHits = 0;
    for (const attempt of list) {
      const actualKey = attempt.error ? '(error)' : attempt.actual ? targetKey(attempt.actual.kind, attempt.actual.name) : '(no selection)';
      breakdown[actualKey] = (breakdown[actualKey] ?? 0) + 1;
      if (attempt.error) {
        errored++;
        erroredAttempts++;
      } else if (attempt.correct) {
        correct++;
        correctAttempts++;
      }
      if (attempt.forbiddenHit) forbiddenHits++;
      // Errored attempts are an API/model failure, not a routing decision — excluded from the
      // confusion matrix too, so it only ever reflects real routing mistakes.
      if (!attempt.error) {
        const confusionKey = `${targetKey(expected.kind, expected.name)}||${actualKey}`;
        confusionCounts.set(confusionKey, (confusionCounts.get(confusionKey) ?? 0) + 1);
      }
    }
    const scoredAttempts = list.length - errored;
    cases.push({
      caseId,
      prompt: list[0].prompt,
      expected,
      attempts: list.length,
      errored,
      correct,
      accuracy: scoredAttempts > 0 ? correct / scoredAttempts : 0,
      forbiddenHits,
      actualBreakdown: breakdown,
    });
  }
  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));

  const confusionMatrix: RouteConfusionEntry[] = [...confusionCounts.entries()]
    .map(([key, count]) => {
      const [expectedKey, actualKey] = key.split('||');
      return { expectedKey, actualKey, count };
    })
    .sort((a, b) => b.count - a.count || a.expectedKey.localeCompare(b.expectedKey));

  const totalAttempts = attempts.length;
  const scoredAttempts = totalAttempts - erroredAttempts;
  return {
    generatedAt: new Date().toISOString(),
    contextDir,
    model,
    repetitions,
    caseIdsHash: computeCaseIdsHash(cases.map((c) => c.caseId)),
    targets,
    cases,
    attempts,
    totalAttempts,
    correctAttempts,
    erroredAttempts,
    accuracy: scoredAttempts > 0 ? correctAttempts / scoredAttempts : 0,
    confusionMatrix,
  };
}

/** Compares a report's accuracy against a previously-written `route-report.json` and flags a
 * regression when accuracy drops by more than `maxAccuracyDropPct` percentage points.
 *
 * Refuses (throws) when the baseline looks like it was run against a different setup — a
 * different model, or a different set of routing cases (`caseIdsHash`) — since an accuracy delta
 * between two incomparable runs is meaningless. Pass `forceBaseline: true` to compare anyway (the
 * report then carries the mismatch reasons under `baseline.incompatibilities` instead of throwing).
 * Older baseline files that predate `model`/`caseIdsHash` skip the checks they lack data for. */
export function compareToBaseline(
  report: RouteReport,
  baselinePath: string,
  maxAccuracyDropPct: number,
  forceBaseline = false,
): RouteReport {
  let raw: string;
  try {
    raw = readFileSync(baselinePath, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read baseline report ${baselinePath}: ${(err as Error).message}`);
  }
  let baseline: { accuracy?: unknown; model?: unknown; caseIdsHash?: unknown };
  try {
    baseline = JSON.parse(raw) as { accuracy?: unknown; model?: unknown; caseIdsHash?: unknown };
  } catch (err) {
    throw new Error(`Baseline report is not valid JSON: ${baselinePath}\n  ${(err as Error).message}`);
  }
  if (typeof baseline.accuracy !== 'number') {
    throw new Error(`Baseline report ${baselinePath} has no numeric "accuracy" field; is it a route-report.json?`);
  }

  const incompatibilities: string[] = [];
  if (typeof baseline.model === 'string' && baseline.model !== report.model) {
    incompatibilities.push(`model differs: baseline was "${baseline.model}", this run is "${report.model}"`);
  }
  if (typeof baseline.caseIdsHash === 'string' && baseline.caseIdsHash !== report.caseIdsHash) {
    incompatibilities.push(
      'case set differs: baseline was run against a different set of routing cases (caseIdsHash mismatch)',
    );
  }
  if (incompatibilities.length > 0 && !forceBaseline) {
    throw new Error(
      `Baseline ${baselinePath} is not comparable to this run:\n` +
        incompatibilities.map((m) => `  - ${m}`).join('\n') +
        `\nAn accuracy delta between the two would not mean anything. Pass --force-baseline to compare anyway.`,
    );
  }

  const baselineAccuracy = baseline.accuracy;
  const delta = (report.accuracy - baselineAccuracy) * 100;
  const regression = delta < -maxAccuracyDropPct;
  return {
    ...report,
    baseline: {
      path: baselinePath,
      accuracy: baselineAccuracy,
      delta,
      maxAllowedDrop: maxAccuracyDropPct,
      regression,
      ...(incompatibilities.length > 0 ? { incompatibilities } : {}),
    },
  };
}

function fmtPct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function renderRouteMarkdownReport(report: RouteReport): string {
  const lines: string[] = [];
  lines.push('# rosettify-prompts route report', '');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Context: ${report.contextDir}`);
  lines.push(`Model: ${report.model}`);
  lines.push(`Repetitions: ${report.repetitions}`);
  lines.push(`Case set: ${report.cases.length} case(s), caseIdsHash=${report.caseIdsHash}`);
  const skillCount = report.targets.filter((t) => t.kind === 'skill').length;
  const workflowCount = report.targets.filter((t) => t.kind === 'workflow').length;
  lines.push(`Targets: ${report.targets.length} (${skillCount} skills, ${workflowCount} workflows)`);
  lines.push('');

  lines.push('## Accuracy', '');
  lines.push(
    `**${fmtPct(report.accuracy)}** (${report.correctAttempts}/${report.totalAttempts - report.erroredAttempts} scored attempts)`,
  );
  if (report.erroredAttempts > 0) {
    lines.push(
      `${report.erroredAttempts}/${report.totalAttempts} attempt(s) errored (API/model failure) and are excluded from accuracy above — see the per-case breakdown.`,
    );
  }
  const totalForbiddenHits = report.cases.reduce((sum, c) => sum + c.forbiddenHits, 0);
  if (totalForbiddenHits > 0) {
    lines.push(`${totalForbiddenHits} attempt(s) landed on a case's forbidden target.`);
  }
  if (report.baseline) {
    lines.push('');
    const sign = report.baseline.delta >= 0 ? '+' : '';
    lines.push(
      `Baseline (\`${report.baseline.path}\`): ${fmtPct(report.baseline.accuracy)} — ` +
        `delta ${sign}${report.baseline.delta.toFixed(1)}pp (max allowed drop ${report.baseline.maxAllowedDrop}pp) — ` +
        `${report.baseline.regression ? '**REGRESSION**' : 'ok'}`,
    );
    if (report.baseline.incompatibilities?.length) {
      lines.push(
        `**Warning**: baseline forced despite: ${report.baseline.incompatibilities.join('; ')}`,
      );
    }
  }
  lines.push('');

  lines.push('## Per-case results', '');
  lines.push('| Case | Expected | Correct | Errored | Accuracy | Forbidden hits | Actual breakdown |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of report.cases) {
    const breakdown = Object.entries(c.actualBreakdown)
      .map(([key, count]) => `${key}×${count}`)
      .join(', ');
    lines.push(
      `| ${c.caseId} | ${targetKey(c.expected.kind, c.expected.name)} | ${c.correct}/${c.attempts - c.errored} | ${c.errored} | ${fmtPct(c.accuracy, 0)} | ${c.forbiddenHits} | ${breakdown} |`,
    );
  }
  lines.push('');

  lines.push('## Confusion matrix', '');
  lines.push('| Expected | Actual | Count |');
  lines.push('| --- | --- | --- |');
  for (const entry of report.confusionMatrix) {
    lines.push(`| ${entry.expectedKey} | ${entry.actualKey} | ${entry.count} |`);
  }

  return lines.join('\n');
}

export function writeRouteReportFiles(report: RouteReport, outDir: string): { jsonPath: string; markdownPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'route-report.json');
  const markdownPath = path.join(outDir, 'route-report.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  writeFileSync(markdownPath, renderRouteMarkdownReport(report), 'utf-8');
  return { jsonPath, markdownPath };
}
