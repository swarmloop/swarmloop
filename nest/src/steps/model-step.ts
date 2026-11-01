import { mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { HistoryService } from '../history/history.service';
import { RunEntity } from '../history/entities';
import { DocumentDraft } from '../history/visit';
import { AgentProcessRunner, AgentRunResult, readSession } from '../limits/agent-runner';
import { sessionFileName } from '../limits/session-group';
import { PipelineResult, StepName } from '../pipeline/pipeline-result';
import { OpenedStep } from '../pipeline/step-run';
import { SandboxMount } from '../sandbox/sandbox-launch';
import { SwarmloopError } from '../swarmloop-error';
import { bulletSection } from './markdown-section';
import { requirementsBrief } from './requirements-brief';

export function textDocument(kind: string, body: string): DocumentDraft {
  return { kind, fileName: '', body };
}

export function returnNotes(parts: { source: string; body: string }[]): DocumentDraft {
  return textDocument('return', `${parts.map((part) => `## ${part.source}\n${part.body.trimEnd()}`).join('\n\n')}\n`);
}

export function mergeHandoff(previous: string | null, step: string, body: string): string {
  const chunk = `## ${step}\n${body.trimEnd()}\n`;
  const sections = splitHandoff(previous ?? '');
  const next = { step, body: chunk };
  const index = sections.findIndex((item) => item.step === step);
  if (index >= 0) {
    sections[index] = next;
  } else {
    sections.push(next);
  }
  return `${sections.map((item) => item.body.trimEnd()).join('\n\n')}\n`;
}

export function withHandoff(
  sections: { heading: string; body: string }[],
  handoff: string | null,
): { heading: string; body: string }[] {
  return handoff?.trim() ? [...sections, { heading: 'What previous steps did', body: handoff }] : sections;
}

export function parseSummary(text: string): string {
  return bulletSection(text, 'summary');
}

export function summaryOr(text: string, fallback: string): string {
  try {
    return parseSummary(text);
  } catch (error) {
    if (!(error instanceof SwarmloopError) || (error.message !== 'summary is missing' && error.message !== 'summary is empty')) {
      throw error;
    }
    const body = fallback.trim();
    if (!body) {
      throw new SwarmloopError('summary is missing');
    }
    return body.endsWith('\n') ? body : `${body}\n`;
  }
}

export function plainSummary(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const cleaned = line.replace(/^[`*]+/, '').replace(/[`*]+$/, '').trim();
      if (!cleaned) {
        return false;
      }
      if (/^decision:\s*(ok|return|approve|revise)\s*$/.test(cleaned)) {
        return false;
      }
      if (/^result:\s*(pass|fail)\s*$/.test(cleaned)) {
        return false;
      }
      if (/^(implementation|summary|plan|repos|questions):$/.test(cleaned)) {
        return false;
      }
      return true;
    });
  return lines.map((line) => (line.startsWith('- ') ? line : `- ${line}`)).join('\n');
}

export async function recordHandoff(history: HistoryService, key: string, step: string, body: string): Promise<DocumentDraft> {
  return textDocument('handoff', mergeHandoff(await history.latestBody(key, 'handoff'), step, body));
}

export function handoffSection(text: string | null, step: string): string {
  const found = splitHandoff(text ?? '').find((item) => item.step === step);
  if (!found) {
    return '';
  }
  return found.body.replace(/^## [^\n]*\n/, '').trim();
}

function splitHandoff(text: string): { step: string; body: string }[] {
  return text
    .split(/^## /m)
    .filter((part) => part.trim())
    .map((part) => {
      const newline = part.indexOf('\n');
      const step = (newline === -1 ? part : part.slice(0, newline)).trim();
      return { step, body: `## ${part.trimEnd()}\n` };
    });
}

export function composedReturn(documents: { kind: string; body: string }[]): string | null {
  const latest = (kind: string): string | null => [...documents].reverse().find((item) => item.kind === kind)?.body ?? null;
  const stored = latest('return');
  if (stored?.trim()) {
    return stored;
  }
  const parts: { source: string; body: string }[] = [];
  for (const source of ['requirements', 'quality', 'regressions', 'security', 'performance']) {
    const body = latest(`review_${source}`);
    if (body && hasLine(body, 'decision: return')) {
      parts.push({ source, body });
    }
  }
  const pipeline = latest('pipeline_log');
  if (pipeline && hasLine(pipeline, 'result: fail')) {
    parts.push({ source: 'pipeline', body: pipeline });
  }
  return parts.length > 0 ? returnNotes(parts).body : null;
}

function hasLine(body: string, line: string): boolean {
  return body.split(/\r?\n/).some((item) => item.trim() === line);
}

export function workingDirectoryBlock(names: string[], mounts: SandboxMount[]): string {
  const labeled = mounts.map((mount, index) => ({
    name: mount.containerPath.startsWith('/work/') ? mount.containerPath.slice('/work/'.length) : (names[index] ?? names[0] ?? 'work'),
    path: mount.containerPath,
    state: sourceState(mount.hostPath),
  }));
  const stay = (where: string): string =>
    `Do not look outside ${where}. Do not open .git. Do not read the home directory, /opt, /proc, transcripts, or CLI files.`;
  if (labeled.length === 1) {
    const only = labeled[0];
    return [`The only working directory is ${only.path} (${only.name}). ${only.state}`, stay('it')].join('\n');
  }
  const lines = labeled.map((item) => `- ${item.name} at ${item.path}. ${item.state}`);
  return ['Working directories, and nowhere else:', ...lines, stay('these paths')].join('\n');
}

export const LOCAL_RUN_RULE = 'Do not start a service, a database, or the application. Do not run tests on this machine.';

export const AGENT_LANGUAGE_RULE = 'Always write in English, even when the request is in another language.';

function sourceState(hostPath: string): string {
  try {
    const entries = readdirSync(hostPath).filter((name) => name !== '.git');
    return entries.length === 0 ? 'It has no source files.' : 'It has source files.';
  } catch {
    return 'It has no source files.';
  }
}

export function skillPrompt(
  skill: string,
  requirements: string,
  names: string[],
  sections: { heading: string; body: string }[] = [],
  mounts: SandboxMount[] = [],
): string {
  const file = join(__dirname, '../../../skills', skill, 'SKILL.md');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new SwarmloopError(`${skill} skill is missing`);
  }
  const where = mounts.length > 0 ? workingDirectoryBlock(names, mounts) : ['Worktrees:', ...names.map((name) => `- ${name}`)].join('\n');
  const parts = [where, '', LOCAL_RUN_RULE, '', text.trimEnd(), '', 'Requirements:', requirementsBrief(requirements)];
  for (const section of sections) {
    parts.push('', `${section.heading}:`, section.body.trimEnd());
  }
  return parts.join('\n');
}

export async function launchAgent(input: {
  agent: AgentProcessRunner;
  history: HistoryService;
  run: RunEntity;
  key: string;
  step: string;
  mode: string;
  model: string;
  timeLimitMs: number;
  prompt: string;
  workspace: string;
  mounts: SandboxMount[];
  liveStep?: string;
  allowHosts?: string[];
  approveMcps?: boolean;
  auto?: boolean;
  resume?: boolean;
  continuePrompt?: string | null;
}): Promise<AgentRunResult> {
  const directory = join(input.history.root(), 'data');
  mkdirSync(directory, { recursive: true });
  const sessionFile = join(directory, sessionFileName(input.key, input.step));
  const stored = await readSession(sessionFile, input.run.runtime);
  const result = await input.agent.run({
    prompt: `${AGENT_LANGUAGE_RULE}\n\n${input.prompt}`,
    workspace: input.workspace,
    outputFile: join(directory, `${input.key}-${input.step}-output.txt`),
    sessionFile,
    model: input.model,
    agentCalls: input.run.agentCalls,
    spentUsd: input.run.spentUsd,
    tokensInRun: await input.history.tokenTotal(input.run.id),
    resumeChatId: input.resume === false ? null : (stored?.chatId ?? null),
    groupUsd: input.resume === false ? 0 : (stored?.usd ?? 0),
    runKey: input.key,
    step: input.step,
    liveStep: input.liveStep,
    mounts: input.mounts,
    allowHosts: input.allowHosts,
    mode: input.mode,
    timeLimitMs: input.timeLimitMs,
    approveMcps: input.approveMcps,
    auto: input.auto,
    continuePrompt: input.continuePrompt,
  });
  input.run.agentCalls += result.calls;
  input.run.spentUsd += result.usd;
  return result;
}

export interface ModelStepContext {
  opened: OpenedStep;
  requirements: string;
  workspace: string;
  end: (
    outcome: 'ok' | 'failed' | 'waiting' | 'blocked',
    exitCode: number,
    line: string,
    document?: DocumentDraft,
    documents?: DocumentDraft[],
    moveTo?: StepName,
  ) => Promise<PipelineResult>;
  launch: (input: {
    prompt: string;
    mounts: SandboxMount[];
    allowHosts?: string[];
    label?: string;
    continuePrompt?: string;
    resume?: boolean;
  }) => Promise<AgentRunResult>;
}

export function combineAgentResults(results: AgentRunResult[]): AgentRunResult | null {
  if (results.length === 0) {
    return null;
  }
  const last = results[results.length - 1];
  const startedAt = results.reduce((min, item) => (item.startedAt < min ? item.startedAt : min), results[0]?.startedAt ?? '');
  const finishedAt = results.reduce((max, item) => (item.finishedAt > max ? item.finishedAt : max), results[0]?.finishedAt ?? '');
  return {
    responseText: last?.responseText ?? '',
    chatId: last?.chatId ?? null,
    tokensIn: results.reduce((sum, item) => sum + item.tokensIn, 0),
    tokensOut: results.reduce((sum, item) => sum + item.tokensOut, 0),
    usd: results.reduce((sum, item) => sum + item.usd, 0),
    killReason: last?.killReason ?? null,
    exitCode: last?.exitCode ?? 0,
    output: foldedOutput(results),
    resumed: results.some((item) => item.resumed),
    calls: results.reduce((sum, item) => sum + item.calls, 0),
    samples: results.flatMap((item) => item.samples),
    durationMs: results.reduce((max, item) => Math.max(max, item.durationMs), 0),
    startedAt,
    finishedAt,
  };
}

/** A later output that already contains an earlier launch replaces it. One that does not is appended. */
function foldedOutput(results: AgentRunResult[]): string | undefined {
  const parts: string[] = [];
  for (const item of results) {
    const next = item.output ?? '';
    if (!next) {
      continue;
    }
    const kept = parts.filter((part) => !outputCovers(next, part));
    parts.length = 0;
    parts.push(...kept, next);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function outputCovers(later: string, earlier: string): boolean {
  if (later.includes(earlier)) {
    return true;
  }
  const strip = (text: string): string => text.split('process started\n').join('');
  const plain = strip(earlier);
  return plain.length > 0 && strip(later).includes(plain);
}

export function agentFailure(result: AgentRunResult, step: string): string | null {
  const denied = writeDenied(result.output);
  if (denied) {
    return `${step} failed: ${denied}`;
  }
  if (result.killReason) {
    return `process killed: ${result.killReason}`;
  }
  if (result.exitCode !== 0) {
    const detail = shortFailure(result.output);
    return detail ? `${step} failed: ${detail}` : `${step} failed`;
  }
  return null;
}

/** A refused Write or Edit is a failed step. The model must not finish with a summary instead. */
function writeDenied(output: string | undefined): string | null {
  if (!output) {
    return null;
  }
  let message: string | null = null;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('permission_denied')) {
      continue;
    }
    try {
      const record = JSON.parse(trimmed) as { subtype?: string; tool_name?: string; message?: string };
      if (record.subtype !== 'permission_denied' || (record.tool_name !== 'Write' && record.tool_name !== 'Edit')) {
        continue;
      }
      const text = typeof record.message === 'string' ? record.message.trim() : '';
      message = (text || 'write permission denied').slice(0, 180);
    } catch {
      continue;
    }
  }
  return message;
}

function shortFailure(output: string | undefined): string {
  const text = (output ?? '').trim();
  if (text.length === 0 || text.length > 500) {
    return '';
  }
  const line = text.split('\n').find((item) => item.trim().length > 0) ?? '';
  return line.trim().slice(0, 180);
}
