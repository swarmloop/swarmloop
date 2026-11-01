import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { DocumentDraft, ExchangeDraft } from '../../history/visit';
import { OpenedStep } from '../../pipeline/step-run';
import { SandboxMount } from '../../sandbox/sandbox-launch';
import { SwarmloopError } from '../../swarmloop-error';
import { launchAgent } from '../agent-step';
import { agentFailure } from '../shared/agent-result';
import { textDocument } from '../shared/handoff';
import { skillPrompt } from '../shared/skill-prompt';
import { REPORT_CONTINUE, reportFollowUp } from './code-review.prompts';
import { Opinion, ReviewDeps, Usage } from './reviewer';

const LABELS: Record<string, string> = {
  review_requirements: 'Requirements',
  review_quality: 'Quality',
  review_regressions: 'Regressions',
  review_security: 'Security',
  review_performance: 'Performance',
};

export function reviewBrief(opinions: { kind: string; decision: 'ok' | 'return'; body: string }[]): string {
  return opinions
    .map((opinion) => {
      const name = LABELS[opinion.kind] ?? opinion.kind.replace(/^review_/, '');
      return [`## ${name}`, `decision: ${opinion.decision}`, '', opinion.body.trimEnd()].join('\n');
    })
    .join('\n\n');
}

export async function writeReport(
  deps: ReviewDeps,
  opened: OpenedStep,
  key: string,
  env: SwarmloopEnv,
  opinions: Opinion[],
  mounts: SandboxMount[],
  requirements: string,
  implementation: string | null,
  continued: boolean,
  auto?: boolean,
): Promise<{ document: DocumentDraft; exchange: ExchangeDraft; usage: Usage } | { error: string; exchange: ExchangeDraft | null; usage: Usage }> {
  const names = mounts.map((mount) => basename(mount.hostPath));
  const brief = reviewBrief(opinions);
  const sections = [
    ...(implementation?.trim() ? [{ heading: 'Implementation', body: implementation }] : []),
    { heading: 'Reviews', body: brief },
  ];
  const prompt = continued
    ? reportFollowUp(brief, implementation)
    : skillPrompt('code-review/report', requirements, names, sections, mounts);
  const model = env.MODEL_PLAN;
  const empty: Usage = { tokensIn: 0, tokensOut: 0, usd: 0, samples: [] };
  try {
    const directory = join(deps.history.root(), 'data');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${key}-code-review-report-output.txt`), 'starting\n');
    const result = await launchAgent({
      agent: deps.agent,
      history: deps.history,
      run: opened.run,
      key,
      step: 'code-review-report',
      mode: 'ask',
      model,
      timeLimitMs: env.CODE_REVIEW_TIMEOUT_MS,
      prompt,
      workspace: mounts[0]?.containerPath ?? '/work',
      mounts,
      auto,
      resume: false,
      continuePrompt: REPORT_CONTINUE,
    });
    const exchange: ExchangeDraft = {
      model,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      requestText: prompt,
      responseText: result.responseText,
      chatId: result.chatId,
      resumed: result.resumed,
      killReason: result.killReason,
    };
    const spent: Usage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut, usd: result.usd, samples: result.samples };
    const failure = agentFailure(result, 'code-review');
    if (failure) {
      return { error: failure, exchange, usage: spent };
    }
    const text = result.responseText.trim();
    if (!text) {
      return { error: 'code-review report is empty', exchange, usage: spent };
    }
    return { document: textDocument('review_report', `${text}\n`), exchange, usage: spent };
  } catch (error) {
    const message = error instanceof SwarmloopError ? error.message : 'code-review failed';
    return { error: message, exchange: null, usage: empty };
  }
}
