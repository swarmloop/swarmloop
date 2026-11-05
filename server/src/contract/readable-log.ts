import { agentDecision } from './readable-log-agent';
import { claudeEvent } from './readable-log-claude';
import { codexEvent } from './readable-log-codex';
import { commonEvent } from './readable-log-events';
import type { ParsedToolCall, ReadableLogEvent } from './readable-log-events';
export { usageFromLog } from './readable-log-usage';
export interface LogMessage {
  type: string;
  text: string;
  code: 'json' | 'shell' | null;
}

export function logFinished(raw: string): boolean {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const line = lines.at(-1) ?? '';
  return line.startsWith('{"type":"result"') || line.startsWith('process exited') || line.startsWith('process killed:');
}

export function reviewChipStatus(raw: string): 'done' | 'waiting' | 'failed' | null {
  if (!logFinished(raw)) {
    return null;
  }
  const decision = agentDecision(raw);
  if (decision === 'ok') {
    return 'done';
  }
  if (decision === 'return') {
    return 'waiting';
  }
  return 'failed';
}

/** Turns a stored agent stream into text a person can read. The stored body stays unchanged. */
export function readableLog(raw: string): string {
  return logMessages(raw)
    .map((message) => render(message))
    .join('\n\n');
}

/** One block per stream message, so the panel can separate them. */
export function logMessages(raw: string): LogMessage[] {
  const writer = new LogWriter();
  for (const line of raw.split('\n')) {
    writer.add(line);
  }
  return writer.messages();
}

interface Block {
  type: string;
  text: string;
}

class LogWriter {
  private readonly blocks: Block[] = [];
  private speech: { type: 'thinking' | 'assistant'; text: string } | null = null;
  private readonly openTools = new Map<string, number[]>();

  add(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }
    if (!trimmed.startsWith('{')) {
      this.closeSpeech();
      this.blocks.push({ type: plainType(trimmed), text: trimmed });
      return;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const event = claudeEvent(record) ?? codexEvent(record) ?? commonEvent(record) ?? fallbackEvent(record);
    this.apply(event);
  }

  messages(): LogMessage[] {
    this.closeSpeech();
    return this.blocks.map((block) => ({ type: block.type, text: block.text, code: codeKind(block) }));
  }

  private apply(event: ReadableLogEvent): void {
    if (event.kind === 'ignore') {
      return;
    }
    if (event.kind === 'close-speech') {
      this.closeSpeech();
      return;
    }
    if (event.kind === 'speech') {
      this.say(event.type, event.text);
      return;
    }
    if (event.kind === 'result') {
      this.closeSpeech();
      const fresh = novel(event.text, this.said());
      if (fresh) {
        this.blocks.push({ type: 'result', text: fresh });
      }
      return;
    }
    this.closeSpeech();
    if (event.kind === 'tool') {
      if (event.call) {
        this.tool(event.call);
      }
      return;
    }
    if (event.text) {
      this.blocks.push({ type: event.type, text: event.text });
    }
  }

  private said(): string {
    return this.blocks
      .filter((block) => block.type === 'assistant')
      .map((block) => block.text)
      .join('\n');
  }

  private say(type: 'thinking' | 'assistant', text: string): void {
    if (text === '') {
      return;
    }
    if (this.speech?.type === type) {
      this.speech.text = text.startsWith(this.speech.text) ? text : this.speech.text + text;
      return;
    }
    this.closeSpeech();
    this.speech = { type, text };
  }

  private closeSpeech(): void {
    if (!this.speech || this.speech.text.trim() === '') {
      this.speech = null;
      return;
    }
    this.blocks.push({ type: this.speech.type, text: this.speech.text.trim() });
    this.speech = null;
  }

  private tool(call: ParsedToolCall): void {
    if (call.completed) {
      const queue = this.openTools.get(call.label);
      const index = queue?.shift();
      if (index === undefined) {
        const text = [call.detail, call.outcome].filter((part) => part !== '').join('\n');
        this.blocks.push({ type: call.label, text });
        return;
      }
      if (call.outcome) {
        const block = this.blocks[index];
        block.text = block.text ? `${block.text}\n${call.outcome}` : call.outcome;
      }
      return;
    }
    const index = this.blocks.length;
    this.blocks.push({ type: call.label, text: call.detail });
    const queue = this.openTools.get(call.label) ?? [];
    queue.push(index);
    this.openTools.set(call.label, queue);
  }
}

function fallbackEvent(record: Record<string, unknown>): ReadableLogEvent {
  if (typeof record.type !== 'string') {
    return { kind: 'ignore' };
  }
  return {
    kind: 'block',
    type: record.type,
    text: typeof record.subtype === 'string' ? record.subtype : '',
  };
}

function codeKind(block: Block): 'json' | 'shell' | null {
  if (block.type === 'shell') {
    return 'shell';
  }
  const trimmed = block.text.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && jsonText(trimmed)) {
    return 'json';
  }
  return null;
}

function jsonText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function render(block: Block): string {
  const body = block.text
    .split('\n')
    .map((line) => (line === '' ? '' : `    ${line}`))
    .join('\n');
  return body ? `${block.type}\n${body}` : block.type;
}

function plainType(line: string): string {
  if (line === 'waiting for output' || line.startsWith('process ')) {
    return 'status';
  }
  return 'note';
}

function novel(text: string, said: string): string | null {
  const have = tight(said);
  const kept = text
    .trim()
    .split('\n')
    .filter((line) => !covered(line, have));
  return kept.length === 0 ? null : kept.join('\n');
}

function covered(line: string, have: string): boolean {
  const bit = tight(line);
  if (bit === '') {
    return true;
  }
  if (have.includes(bit) || (have !== '' && bit.startsWith(have))) {
    return true;
  }
  const head = bit.slice(0, 80);
  return head.length >= 40 && have.includes(head);
}

function tight(text: string): string {
  return text.replace(/\s+/g, '');
}
