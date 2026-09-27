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

export function buildRouteReport(
  contextDir: string,
  model: string,
  targets: RouteTarget[],
  attempts: RouteAttemptResult[],
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

  for (const [caseId, list] of byCase) {
    const expected = list[0].expected;
    const breakdown: Record<string, number> = {};
    let correct = 0;
    for (const attempt of list) {
      const actualKey = attempt.error ? '(error)' : attempt.actual ? targetKey(attempt.actual.kind, attempt.actual.name) : '(no selection)';
      breakdown[actualKey] = (breakdown[actualKey] ?? 0) + 1;
      if (attempt.correct) {
        correct++;
        correctAttempts++;
      }
      const confusionKey = `${targetKey(expected.kind, expected.name)}||${actualKey}`;
      confusionCounts.set(confusionKey, (confusionCounts.get(confusionKey) ?? 0) + 1);
    }
    cases.push({
      caseId,
      prompt: list[0].prompt,
      expected,
      attempts: list.length,
      correct,
      accuracy: list.length > 0 ? correct / list.length : 0,
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
  return {
    generatedAt: new Date().toISOString(),
    contextDir,
    model,
    targets,
    cases,
    attempts,
    totalAttempts,
    correctAttempts,
    accuracy: totalAttempts > 0 ? correctAttempts / totalAttempts : 0,
    confusionMatrix,
  };
}

/** Compares a report's accuracy against a previously-written `route-report.json` and flags a
 * regression when accuracy drops by more than `maxAccuracyDropPct` percentage points. */
export function compareToBaseline(report: RouteReport, baselinePath: string, maxAccuracyDropPct: number): RouteReport {
  let raw: string;
  try {
    raw = readFileSync(baselinePath, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read baseline report ${baselinePath}: ${(err as Error).message}`);
  }
  let baseline: { accuracy?: unknown };
  try {
    baseline = JSON.parse(raw) as { accuracy?: unknown };
  } catch (err) {
    throw new Error(`Baseline report is not valid JSON: ${baselinePath}\n  ${(err as Error).message}`);
  }
  if (typeof baseline.accuracy !== 'number') {
    throw new Error(`Baseline report ${baselinePath} has no numeric "accuracy" field; is it a route-report.json?`);
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
  const skillCount = report.targets.filter((t) => t.kind === 'skill').length;
  const workflowCount = report.targets.filter((t) => t.kind === 'workflow').length;
  lines.push(`Targets: ${report.targets.length} (${skillCount} skills, ${workflowCount} workflows)`);
  lines.push('');

  lines.push('## Accuracy', '');
  lines.push(`**${fmtPct(report.accuracy)}** (${report.correctAttempts}/${report.totalAttempts} attempts)`);
  if (report.baseline) {
    lines.push('');
    const sign = report.baseline.delta >= 0 ? '+' : '';
    lines.push(
      `Baseline (\`${report.baseline.path}\`): ${fmtPct(report.baseline.accuracy)} — ` +
        `delta ${sign}${report.baseline.delta.toFixed(1)}pp (max allowed drop ${report.baseline.maxAllowedDrop}pp) — ` +
        `${report.baseline.regression ? '**REGRESSION**' : 'ok'}`,
    );
  }
  lines.push('');

  lines.push('## Per-case results', '');
  lines.push('| Case | Expected | Correct | Accuracy | Actual breakdown |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of report.cases) {
    const breakdown = Object.entries(c.actualBreakdown)
      .map(([key, count]) => `${key}×${count}`)
      .join(', ');
    lines.push(
      `| ${c.caseId} | ${targetKey(c.expected.kind, c.expected.name)} | ${c.correct}/${c.attempts} | ${fmtPct(c.accuracy, 0)} | ${breakdown} |`,
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
