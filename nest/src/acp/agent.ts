import { existsSync } from 'fs';
import { basename, isAbsolute, join, resolve } from 'path';
import { Writable } from 'stream';
import { encodeMessage, JsonRpc, pushFrames } from './framing';
import { sessionTitle } from './format';
import { liveLogBody } from './live-output';
import { FlowView, NestApi } from './nest-api';
import { readableLog } from './readable-log';
import { nestCheckout } from './paths';
import { REVIEW_STEPS } from '../pipeline/pipeline-result';
import { CHECKOUT_NAME } from '../steps/prepare/checkout-path';

export interface SkillCommand {
  name: string;
  description: string;
}

interface Session {
  id: string;
  cwd: string;
  folders: string[];
  mcpServers: unknown;
  runKey: string | null;
  cancelled: boolean;
}

interface Command {
  name: string;
  rest: string;
}

export interface SloopOptions {
  api: NestApi;
  skills: SkillCommand[];
  repoRoot: string;
  checkoutsRoot?: string;
  cwd?: string;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  now?: () => number;
}

const MISSING_POLLS = 20;

export async function serve(input: AsyncIterable<Buffer | string> | Iterable<Buffer | string>, output: Writable, agent: Sloop): Promise<void> {
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  const write = (message: unknown): Promise<void> => {
    const encoded = encodeMessage(message);
    const next = chain.then(() => {
      output.write(encoded);
    });
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const emit = (note: JsonRpc): void => {
    void write(note);
  };
  let turn = Promise.resolve();
  const pending: Promise<unknown>[] = [];
  const dispatch = (message: JsonRpc): void => {
    const run = (): Promise<void> =>
      agent.handle(message, emit).then(async (response) => {
        if (response) {
          await write(response);
        }
      });
    if (message.method === 'session/cancel') {
      pending.push(run());
      return;
    }
    turn = turn.then(run, run);
    pending.push(turn);
  };
  for await (const chunk of input) {
    const parsed = pushFrames(buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    buffer = Buffer.from(parsed.buffer);
    for (const message of parsed.messages) {
      dispatch(message);
    }
  }
  await Promise.all(pending);
}

export class Sloop {
  private readonly sessions = new Map<string, Session>();
  private serial = 0;

  constructor(private readonly options: SloopOptions) {}

  async handle(request: JsonRpc, emit: (note: JsonRpc) => void): Promise<JsonRpc | null> {
    const method = request.method ?? '';
    if (request.id === undefined || request.id === null) {
      if (method === 'session/cancel') {
        await this.cancel(request.params);
      }
      return null;
    }
    try {
      const result = await this.dispatch(method, request.params, emit);
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message } };
    }
  }

  private async dispatch(method: string, params: unknown, emit: (note: JsonRpc) => void): Promise<unknown> {
    const row = record(params);
    switch (method) {
      case 'initialize':
        return this.initialize(row);
      case 'session/list':
        return this.list(row);
      case 'session/new':
        return this.open(row, emit);
      case 'session/resume':
      case 'session/load':
        return this.resume(row, emit);
      case 'session/prompt':
        return this.prompt(row, emit);
      case 'session/cancel':
        await this.cancel(params);
        return {};
      case 'session/close':
        this.sessions.delete(stringOf(row.sessionId));
        return {};
      case 'authenticate':
        return {};
      default:
        throw new Error(`${method} is unknown`);
    }
  }

  private initialize(params: Record<string, unknown>): unknown {
    const version = typeof params.protocolVersion === 'number' ? params.protocolVersion : 1;
    return {
      protocolVersion: version,
      agentInfo: { name: 'sloop', title: 'sloop', version: '0.1.0' },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, embeddedContext: true },
        sessionCapabilities: { list: {}, load: {}, resume: {}, close: {} },
      },
    };
  }

  private async list(params: Record<string, unknown>): Promise<unknown> {
    const listed = await this.options.api.list();
    const cwd = this.directory(stringOf(params.cwd));
    return {
      sessions: listed.runs.map((run) => ({
        sessionId: run.key,
        cwd,
        title: sessionTitle(run),
        updatedAt: run.updatedAt,
      })),
    };
  }

  private open(params: Record<string, unknown>, emit: (note: JsonRpc) => void): unknown {
    const id = `sloop-${(this.options.now ?? Date.now)().toString(36)}-${this.serial}`;
    this.serial += 1;
    const session: Session = {
      id,
      cwd: this.directory(stringOf(params.cwd)),
      folders: this.rootFolders(params),
      mcpServers: params.mcpServers,
      runKey: null,
      cancelled: false,
    };
    this.sessions.set(id, session);
    this.commands(session, emit);
    this.panel(session, emit);
    return { sessionId: id };
  }

  private async resume(params: Record<string, unknown>, emit: (note: JsonRpc) => void): Promise<unknown> {
    const id = stringOf(params.sessionId);
    if (!id) {
      throw new Error('session is missing');
    }
    const known = this.sessions.get(id);
    const session: Session = known ?? {
      id,
      cwd: this.directory(stringOf(params.cwd)),
      folders: this.rootFolders(params),
      mcpServers: params.mcpServers,
      runKey: id.startsWith('sloop-') ? null : id,
      cancelled: false,
    };
    session.cwd = this.directory(stringOf(params.cwd) || session.cwd);
    session.folders = this.rootFolders({ ...params, cwd: session.cwd });
    if (params.mcpServers !== undefined) {
      session.mcpServers = params.mcpServers;
    }
    this.sessions.set(id, session);
    this.commands(session, emit);
    this.panel(session, emit);
    if (session.runKey) {
      try {
        await this.show(session, emit);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'request failed';
        this.chunk(session, `${message}\n`, emit);
      }
    }
    return { sessionId: id };
  }

  private async prompt(params: Record<string, unknown>, emit: (note: JsonRpc) => void): Promise<unknown> {
    const session = this.session(stringOf(params.sessionId), stringOf(params.cwd));
    session.cancelled = false;
    const text = promptText(params.prompt);
    if (!text) {
      throw new Error('prompt is missing');
    }
    const command = parseCommand(text);
    if (command?.name === 'review') {
      await this.review(session, command.rest, emit);
    } else if (command?.name === 'replay') {
      await this.replay(session, command.rest, emit);
    } else if (command?.name === 'resume') {
      await this.continueRun(session, command.rest, emit);
    } else if (command?.name === 'step') {
      await this.runStep(session, command.rest, emit);
    } else if (command && this.skill(command.name)) {
      await this.chat(session, command.rest || 'Follow the skill.', command.name, emit);
    } else if (command) {
      this.chunk(session, `unknown command /${command.name}\n`, emit);
    } else if (!session.runKey) {
      const projects = this.gitProjects(session);
      if (projects.length === 0) {
        throw new Error('project is missing');
      }
      const created = await this.options.api.create({ prompt: text, projects });
      session.runKey = created.key;
      // PhpStorm locks the first title. Name the chat before any text, or the prompt stays.
      this.name(session, created.key, emit);
      this.chunk(session, `${created.key} started\n${panelUrl(created.key)}\n`, emit);
      if (created.status !== 'done') {
        await this.watch(session, emit);
      }
    } else {
      await this.chat(session, text, undefined, emit);
    }
    return { stopReason: session.cancelled ? 'cancelled' : 'end_turn' };
  }

  private async review(session: Session, rest: string, emit: (note: JsonRpc) => void): Promise<void> {
    const path = this.reviewPath(session, rest);
    const created = await this.options.api.create({ path, prompt: reviewPrompt(rest) });
    session.runKey = created.key;
    this.name(session, created.key, emit);
    this.chunk(session, `${created.key} code review started\n`, emit);
    if (created.status !== 'done') {
      await this.watch(session, emit);
    }
  }

  private async bindRun(session: Session): Promise<string> {
    if (session.runKey) {
      return session.runKey;
    }
    const listed = await this.options.api.list();
    let latest = listed.runs[0];
    for (const run of listed.runs) {
      if (latest && run.updatedAt > latest.updatedAt) {
        latest = run;
      }
    }
    const key = latest?.key;
    if (!key) {
      throw new Error('feature is missing');
    }
    session.runKey = key;
    return key;
  }

  private async replay(session: Session, rest: string, emit: (note: JsonRpc) => void): Promise<void> {
    if (!session.runKey) {
      throw new Error('feature is missing');
    }
    if (!rest.trim()) {
      throw new Error('prompt is missing');
    }
    const started = await this.options.api.replay(session.runKey, 'requirements', { prompt: rest });
    this.name(session, started.key, emit);
    this.chunk(session, `${started.key} replay started\n`, emit);
    if (started.status !== 'done') {
      await this.watch(session, emit);
    }
  }

  private async continueRun(session: Session, rest: string, emit: (note: JsonRpc) => void): Promise<void> {
    const key = await this.bindRun(session);
    const prompt = rest.trim();
    const started = await this.options.api.resume(key, prompt ? { prompt } : {});
    this.name(session, started.key, emit);
    this.chunk(session, `${started.key} resumed\n`, emit);
    if (started.status !== 'done') {
      await this.watch(session, emit);
    }
  }

  private async runStep(session: Session, rest: string, emit: (note: JsonRpc) => void): Promise<void> {
    const key = await this.bindRun(session);
    const [name, ...tail] = rest.split(/\s+/).filter((part) => part.length > 0);
    if (!name) {
      throw new Error('step is missing');
    }
    const prompt = tail.join(' ').trim();
    const started = await this.options.api.step(key, name, { prompt: prompt || undefined });
    this.name(session, started.key, emit);
    this.chunk(session, `${started.key} ${name} started\n`, emit);
    if (started.status !== 'done') {
      await this.watch(session, emit);
    }
  }

  private async chat(session: Session, text: string, skill: string | undefined, emit: (note: JsonRpc) => void): Promise<void> {
    if (!session.runKey) {
      throw new Error('start the feature with a prompt first');
    }
    try {
      const result = await this.options.api.chat(session.runKey, {
        prompt: text,
        skill,
        cwd: this.visible(session.cwd),
        mcpServers: session.mcpServers,
      });
      const body = result.text.trimEnd();
      this.chunk(session, body.length > 0 ? `${body}\n` : '\n', emit);
    } catch (error) {
      if (session.cancelled) {
        return;
      }
      throw error;
    }
  }

  private async cancel(params: unknown): Promise<void> {
    const session = this.sessions.get(stringOf(record(params).sessionId));
    if (!session) {
      return;
    }
    session.cancelled = true;
    if (!session.runKey) {
      return;
    }
    try {
      await this.options.api.stop(session.runKey);
    } catch {
      // The prompt already ends. A stop failure must not keep the turn open.
    }
  }

  private async show(session: Session, emit: (note: JsonRpc) => void): Promise<void> {
    if (!session.runKey) {
      return;
    }
    const flow = await this.options.api.flow(session.runKey);
    this.report(session, flow, emit);
  }

  private async watch(session: Session, emit: (note: JsonRpc) => void): Promise<void> {
    if (!session.runKey) {
      return;
    }
    let seen = '';
    let shownLogs = new Map<string, string>();
    let logStep = '';
    let missing = 0;
    for (;;) {
      if (session.cancelled) {
        return;
      }
      let flow: Awaited<ReturnType<NestApi['flow']>>;
      try {
        flow = await this.options.api.flow(session.runKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!message.includes('is missing') || missing >= MISSING_POLLS) {
          throw error;
        }
        missing += 1;
        await (this.options.sleep ?? delay)(this.options.intervalMs ?? 1_500);
        continue;
      }
      missing = 0;
      const body = progressText(flow);
      if (body !== seen) {
        this.report(session, flow, emit);
        seen = body;
      }
      if (flow.currentStep !== logStep) {
        logStep = flow.currentStep;
        shownLogs = new Map();
      }
      for (const part of this.liveLogs(session.runKey, flow.currentStep)) {
        this.emitLog(session, part, shownLogs, emit);
      }
      if (flow.status !== 'running') {
        return;
      }
      await (this.options.sleep ?? delay)(this.options.intervalMs ?? 1_500);
    }
  }

  private reviewPath(session: Session, rest: string): string {
    const first = rest.split(/\s+/)[0] ?? '';
    if (!looksLikePath(first)) {
      return this.visible(session.cwd);
    }
    const chosen = isAbsolute(first) ? first : resolve(session.cwd, first);
    return this.visible(chosen);
  }

  private visible(hostPath: string): string {
    return nestCheckout(hostPath, this.options.repoRoot, this.options.checkoutsRoot);
  }

  private rootFolders(params: Record<string, unknown>): string[] {
    const cwd = this.directory(stringOf(params.cwd));
    const extra = Array.isArray(params.roots) ? params.roots : [];
    const paths = [
      cwd,
      ...extra.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => this.directory(item)),
    ];
    return [...new Set(paths)];
  }

  private gitProjects(session: Session): string[] {
    const names: string[] = [];
    for (const folder of session.folders) {
      if (!existsSync(join(folder, '.git'))) {
        continue;
      }
      const name = basename(this.visible(folder));
      if (name === 'checkouts' || name.startsWith('.') || name.startsWith('run-') || !CHECKOUT_NAME.test(name)) {
        continue;
      }
      names.push(name);
    }
    return [...new Set(names)].sort();
  }

  private directory(value: string | undefined): string {
    const base = this.options.cwd ?? process.cwd();
    const cwd = value && value.trim().length > 0 ? value.trim() : base;
    return isAbsolute(cwd) ? cwd : resolve(base, cwd);
  }

  private session(id: string, cwd?: string): Session {
    if (!id) {
      throw new Error('session is missing');
    }
    const existing = this.sessions.get(id);
    if (existing) {
      if (cwd) {
        existing.cwd = this.directory(cwd);
        if (!existing.folders.includes(existing.cwd)) {
          existing.folders.push(existing.cwd);
        }
      }
      return existing;
    }
    if (id.startsWith('sloop-')) {
      throw new Error('session is missing');
    }
    const created: Session = {
      id,
      cwd: this.directory(cwd),
      folders: [this.directory(cwd)],
      mcpServers: undefined,
      runKey: id,
      cancelled: false,
    };
    this.sessions.set(id, created);
    return created;
  }

  private skill(name: string): SkillCommand | undefined {
    return this.options.skills.find((skill) => skill.name === name);
  }

  private commands(session: Session, emit: (note: JsonRpc) => void): void {
    const availableCommands = [
      ...this.options.skills.map((skill) => ({ name: skill.name, description: skill.description })),
      { name: 'step', description: 'Run a pipeline step. The next word is the step name.' },
      { name: 'resume', description: 'Run the failed step again.' },
      { name: 'replay', description: 'Restart this feature from requirements. The rest is the new prompt.' },
      { name: 'review', description: 'Start a code review of this directory, or of a directory named after the command.' },
    ];
    emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: session.id, update: { sessionUpdate: 'available_commands_update', availableCommands } },
    });
  }

  private name(session: Session, title: string, emit: (note: JsonRpc) => void): void {
    const updatedAt = new Date(this.options.now?.() ?? Date.now()).toISOString();
    emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: session.id, update: { sessionUpdate: 'session_info_update', title, updatedAt } },
    });
  }

  private report(session: Session, flow: FlowView, emit: (note: JsonRpc) => void): void {
    this.name(session, flow.key, emit);
    const entries = planEntries(flow);
    if (entries.length > 0) {
      emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: session.id, update: { sessionUpdate: 'plan', entries } },
      });
    }
    this.chunk(session, progressText(flow), emit);
  }

  private panel(session: Session, emit: (note: JsonRpc) => void): void {
    this.chunk(session, `${panelUrl(session.runKey)}\n`, emit);
  }

  private liveLogs(key: string, step: string): { name: string; text: string }[] {
    const names = step === 'code-review' ? [...REVIEW_STEPS, 'code-review-report'] : [step];
    return names.flatMap((name) => {
      const text = this.transcript(key, name);
      return text ? [{ name, text }] : [];
    });
  }

  private emitLog(session: Session, part: { name: string; text: string }, shown: Map<string, string>, emit: (note: JsonRpc) => void): void {
    const prev = shown.get(part.name) ?? '';
    const label = part.name.startsWith('code-review-') ? part.name.slice('code-review-'.length) : '';
    if (part.text.startsWith(prev)) {
      const delta = part.text.slice(prev.length);
      if (delta) {
        this.chunk(session, `${prev === '' && label ? `\n${label}\n` : ''}${delta}`, emit);
      }
    } else if (part.text !== prev) {
      this.chunk(session, label ? `\n${label}\n${part.text}` : part.text, emit);
    }
    shown.set(part.name, part.text);
  }

  private transcript(key: string, step: string): string {
    const raw = liveLogBody(this.options.repoRoot, key, step).trim();
    if (!raw || raw === 'waiting for output') {
      return '';
    }
    return readableLog(raw);
  }

  private chunk(session: Session, text: string, emit: (note: JsonRpc) => void): void {
    emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: session.id,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    });
  }
}

const PANEL_ORIGIN = 'http://127.0.0.1:3921';
const RUNNING_FILLER = 'This step is running. The output is below.';

export function panelUrl(runKey: string | null): string {
  if (!runKey) {
    return PANEL_ORIGIN;
  }
  return `${PANEL_ORIGIN}/runs/${encodeURIComponent(runKey)}`;
}

// The chat appends every update, so the message is one line. The plan carries the board and the client replaces it.
export function progressText(flow: FlowView): string {
  const phase = (flow.phases ?? []).find((group) => group.steps.some((step) => step.name === flow.currentStep))?.phase;
  const place = phase ? `${phase} · ${flow.currentStep}` : flow.currentStep;
  const line = `${flow.key} · ${place} — ${flow.status}`;
  const sentence = (flow.sentence ?? '').trim();
  if (!sentence || sentence === RUNNING_FILLER) {
    return `${line}\n`;
  }
  return `${line}\n\n${sentence}\n`;
}

export function planEntries(flow: FlowView): { content: string; priority: 'high' | 'medium'; status: 'pending' | 'in_progress' | 'completed' }[] {
  return (flow.phases ?? []).flatMap((group) =>
    group.steps.map((step) => ({
      content: `${group.phase} · ${step.name} — ${step.status}`,
      priority: step.name === flow.currentStep ? 'high' : 'medium',
      status: step.status === 'done' ? 'completed' : step.status === 'idle' || step.status === 'skipped' ? 'pending' : 'in_progress',
    })),
  );
}

export function parseCommand(text: string): Command | null {
  const match = /^\/([A-Za-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) {
    return null;
  }
  return { name: match[1].toLowerCase(), rest: (match[2] ?? '').trim() };
}

function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('.') || value.includes('/') || value.includes('\\');
}

function reviewPrompt(rest: string): string {
  const parts = rest.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0 || !looksLikePath(parts[0])) {
    return rest.trim() || 'Review this checkout.';
  }
  const note = parts.slice(1).join(' ').trim();
  return note.length > 0 ? note : 'Review this checkout.';
}

function promptText(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return '';
      }
      const row = block as { text?: unknown; content?: { text?: unknown } };
      if (typeof row.text === 'string') {
        return row.text;
      }
      return typeof row.content?.text === 'string' ? row.content.text : '';
    })
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
