import type { Writable } from 'stream';
import type { JsonRpc } from './framing';
import { encodeMessage, pushFrames } from './framing';
import { CommandHandler, panelUrl as commandPanelUrl, promptText } from './commands';
import { SessionStore, type Session } from './sessions';
import { sessionTitle } from './format';
import { liveLogBody } from './live-output';
import type { FlowView } from '../contract/api';
import type { ServerApi } from './server-api';
import { readableLog } from '../contract/readable-log';
import { nestCheckout } from './paths';
import { REVIEW_STEPS } from '../contract/steps';
import type { Clock } from '../core/clock';
export { panelUrl, parseCommand } from './commands';
export type { SkillCommand } from './commands';

export interface SloopOptions {
  api: ServerApi;
  skills: import('./commands').SkillCommand[];
  repoRoot: string;
  checkoutsRoot?: string;
  cwd?: string;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  clock: Clock;
}

const MISSING_POLLS = 20;

export async function serve(
  input: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
  output: Writable,
  agent: Sloop,
): Promise<void> {
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
  private readonly sessions: SessionStore;
  private readonly commands: CommandHandler;

  constructor(private readonly options: SloopOptions) {
    this.sessions = new SessionStore({ cwd: options.cwd, now: () => options.clock.now() });
    this.commands = new CommandHandler({
      ...options,
      visible: (path) => this.visible(path),
      watch: (session, emit) => this.watch(session, emit),
      name: (session, title, emit) => this.name(session, title, emit),
      chunk: (session, text, emit) => this.chunk(session, text, emit),
    });
  }

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
        this.sessions.close(stringOf(row.sessionId));
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
    const cwd = this.sessions.directory(stringOf(params.cwd));
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
    const session = this.sessions.open(params);
    this.commands.commands(session, emit);
    this.panel(session, emit);
    return { sessionId: session.id };
  }

  private async resume(params: Record<string, unknown>, emit: (note: JsonRpc) => void): Promise<unknown> {
    const session = this.sessions.restore(params);
    this.commands.commands(session, emit);
    this.panel(session, emit);
    if (session.runKey) {
      try {
        await this.show(session, emit);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'request failed';
        this.chunk(session, `${message}\n`, emit);
      }
    }
    return { sessionId: session.id };
  }

  private async prompt(params: Record<string, unknown>, emit: (note: JsonRpc) => void): Promise<unknown> {
    const session = this.sessions.get(stringOf(params.sessionId), stringOf(params.cwd));
    session.cancelled = false;
    const text = promptText(params.prompt);
    if (!text) {
      throw new Error('prompt is missing');
    }
    await this.commands.prompt(session, text, emit);
    return { stopReason: session.cancelled ? 'cancelled' : 'end_turn' };
  }

  private async cancel(params: unknown): Promise<void> {
    const session = this.sessions.find(stringOf(record(params).sessionId));
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
      let flow: Awaited<ReturnType<ServerApi['flow']>>;
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

  private visible(hostPath: string): string {
    return nestCheckout(hostPath, this.options.repoRoot, this.options.checkoutsRoot);
  }

  private name(session: Session, title: string, emit: (note: JsonRpc) => void): void {
    const updatedAt = this.options.clock.iso();
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
    this.chunk(session, `${commandPanelUrl(session.runKey)}\n`, emit);
  }

  private liveLogs(key: string, step: string): { name: string; text: string }[] {
    const names = step === 'code-review' ? [...REVIEW_STEPS, 'code-review-report'] : [step];
    return names.flatMap((name) => {
      const text = this.transcript(key, name);
      return text ? [{ name, text }] : [];
    });
  }

  private emitLog(
    session: Session,
    part: { name: string; text: string },
    shown: Map<string, string>,
    emit: (note: JsonRpc) => void,
  ): void {
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

const RUNNING_FILLER = 'This step is running. The output is below.';

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

export function planEntries(
  flow: FlowView,
): { content: string; priority: 'high' | 'medium'; status: 'pending' | 'in_progress' | 'completed' }[] {
  return (flow.phases ?? []).flatMap((group) =>
    group.steps.map((step) => ({
      content: `${group.phase} · ${step.name} — ${step.status}`,
      priority: step.name === flow.currentStep ? 'high' : 'medium',
      status:
        step.status === 'done'
          ? 'completed'
          : step.status === 'idle' || step.status === 'skipped'
            ? 'pending'
            : 'in_progress',
    })),
  );
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
