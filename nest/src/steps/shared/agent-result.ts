import { AgentRunResult } from '../../limits/agent-runner';

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
