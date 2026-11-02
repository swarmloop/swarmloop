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

/** The skill example lives in the user prompt. Only the agent's own decision line counts. */
function agentDecision(raw: string): 'ok' | 'return' | null {
  let found: 'ok' | 'return' | null = null;
  for (const line of raw.split('\n')) {
    const text = agentText(line);
    if (!text) {
      continue;
    }
    for (const row of text.split('\n')) {
      const cleaned = row.trim().replace(/^[`*]+/, '').replace(/[`*]+$/, '').trim();
      const match = /^decision:\s*(ok|return)\s*$/.exec(cleaned);
      if (match?.[1] === 'ok' || match?.[1] === 'return') {
        found = match[1];
      }
    }
  }
  return found;
}

function agentText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return line;
  }
  let record: { type?: unknown; result?: unknown; message?: { content?: unknown } };
  try {
    record = JSON.parse(trimmed) as { type?: unknown; result?: unknown; message?: { content?: unknown } };
  } catch {
    return line;
  }
  if (record.type === 'user') {
    return null;
  }
  if (typeof record.result === 'string') {
    return record.result;
  }
  const content = record.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('');
  return text.length > 0 ? text : null;
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

/** Token counts travel on the final result line. Earlier lines do not carry them. */
export function usageFromLog(raw: string): { tokensIn: number; tokensOut: number } | null {
  let found: { tokensIn: number; tokensOut: number } | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"usage"')) {
      continue;
    }
    let record: { usage?: unknown };
    try {
      record = JSON.parse(trimmed) as { usage?: unknown };
    } catch {
      continue;
    }
    if (!isRecord(record.usage)) {
      continue;
    }
    const tokensIn = numberField(record.usage, ['inputTokens', 'input_tokens', 'prompt_tokens']);
    const tokensOut = numberField(record.usage, ['outputTokens', 'output_tokens', 'completion_tokens']);
    const cacheRead = numberField(record.usage, ['cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens']);
    const cacheWrite = numberField(record.usage, ['cacheWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens']);
    if (tokensIn === null && tokensOut === null && cacheRead === null && cacheWrite === null) {
      continue;
    }
    found = { tokensIn: (tokensIn ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0), tokensOut: tokensOut ?? 0 };
  }
  return found;
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
    if (record.type === 'thinking') {
      if (record.subtype === 'completed') {
        this.closeSpeech();
        return;
      }
      this.say('thinking', typeof record.text === 'string' ? record.text : '');
      return;
    }
    if (record.type === 'system' || record.type === 'user') {
      return;
    }
    if (record.type === 'assistant') {
      this.say('assistant', textOf(record) ?? '');
      return;
    }
    if (record.type === 'result') {
      this.closeSpeech();
      const fresh = novel(typeof record.result === 'string' ? record.result : '', this.said());
      if (fresh) {
        this.blocks.push({ type: 'result', text: fresh });
      }
      return;
    }
    if (record.type === 'tool_call') {
      this.closeSpeech();
      this.tool(record);
      return;
    }
    if (record.type === 'connection' || record.type === 'retry') {
      this.closeSpeech();
      const text = eventText(record);
      if (text) {
        this.blocks.push({ type: String(record.type), text });
      }
      return;
    }
    if (typeof record.type === 'string') {
      this.closeSpeech();
      const text = typeof record.subtype === 'string' ? record.subtype : '';
      if (text) {
        this.blocks.push({ type: record.type, text });
      }
    }
  }

  messages(): LogMessage[] {
    this.closeSpeech();
    return this.blocks.map((block) => ({ type: block.type, text: block.text, code: codeKind(block) }));
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

  private tool(record: Record<string, unknown>): void {
    const call = openedTool(record);
    if (!call) {
      return;
    }
    if (record.subtype === 'completed') {
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

function eventText(record: Record<string, unknown>): string {
  const subtype = typeof record.subtype === 'string' ? record.subtype : '';
  const attempt = typeof record.attempt === 'number' ? `attempt ${record.attempt}` : '';
  return [subtype, attempt].filter((part) => part !== '').join(', ');
}

function textOf(record: Record<string, unknown>): string | null {
  if (typeof record.result === 'string') {
    return record.result;
  }
  const message = record.message;
  if (!isRecord(message)) {
    return null;
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
  return text === '' ? null : text;
}

function openedTool(record: Record<string, unknown>): { label: string; detail: string; outcome: string } | null {
  const call = record.tool_call;
  if (!isRecord(call)) {
    return null;
  }
  const entry = Object.entries(call).find(([, body]) => isRecord(body) && (isRecord(body.args) || isRecord(body.result) || body.rejected !== undefined));
  if (!entry) {
    return null;
  }
  const [name, body] = entry;
  const label = name.replace(/ToolCall$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const args = isRecord(body) && isRecord(body.args) ? body.args : {};
  return {
    label,
    detail: argDetail(label, args),
    outcome: record.subtype === 'completed' ? outcome(isRecord(body) ? body.result : null) : '',
  };
}

function argDetail(label: string, args: Record<string, unknown>): string {
  if (label === 'shell' && typeof args.command === 'string') {
    return args.command;
  }
  if (label === 'grep' && typeof args.pattern === 'string') {
    const path = typeof args.path === 'string' ? ` ${args.path}` : '';
    return `${args.pattern}${path}`;
  }
  if (typeof args.path === 'string') {
    return args.path;
  }
  if (typeof args.targetDirectory === 'string' || typeof args.globPattern === 'string') {
    return [args.targetDirectory, args.globPattern].filter((part) => typeof part === 'string').join(' ');
  }
  return '';
}

function outcome(result: unknown): string {
  if (!isRecord(result)) {
    return '';
  }
  if (result.rejected) {
    return 'rejected';
  }
  const success = isRecord(result.success) ? result.success : null;
  if (success && typeof success.totalFiles === 'number') {
    return `${success.totalFiles} files`;
  }
  if (success && typeof success.stdout === 'string' && success.stdout.trim() !== '') {
    return success.stdout.replace(/\s+$/, '');
  }
  if (success && typeof success.exitCode === 'number' && success.exitCode !== 0) {
    return `exit ${success.exitCode}`;
  }
  const error = result.error ?? success?.error;
  if (typeof error === 'string' && error !== '') {
    return error.replace(/\s+$/, '');
  }
  return '';
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
