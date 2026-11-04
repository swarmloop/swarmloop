import { existsSync } from 'fs';
import { basename, isAbsolute, join, resolve } from 'path';
import type { JsonRpc } from './framing';
import type { ServerApi } from './server-api';
import type { Session } from './sessions';
import { CHECKOUT_NAME } from '../steps/prepare/checkout-path';

export interface SkillCommand {
  name: string;
  description: string;
}

export interface Command {
  name: string;
  rest: string;
}

export interface CommandHandlerOptions {
  api: ServerApi;
  skills: SkillCommand[];
  repoRoot: string;
  checkoutsRoot?: string;
  visible: (path: string) => string;
  watch: (session: Session, emit: (note: JsonRpc) => void) => Promise<void>;
  name: (session: Session, title: string, emit: (note: JsonRpc) => void) => void;
  chunk: (session: Session, text: string, emit: (note: JsonRpc) => void) => void;
}

export class CommandHandler {
  constructor(private readonly options: CommandHandlerOptions) {}

  async prompt(session: Session, text: string, emit: (note: JsonRpc) => void): Promise<void> {
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
      this.options.chunk(session, `unknown command /${command.name}\n`, emit);
    } else if (!session.runKey) {
      const projects = this.gitProjects(session);
      if (projects.length === 0) {
        throw new Error('project is missing');
      }
      const created = await this.options.api.create({ prompt: text, projects });
      session.runKey = created.key;
      // PhpStorm locks the first title. Name the chat before any text, or the prompt stays.
      this.options.name(session, created.key, emit);
      this.options.chunk(session, `${created.key} started\n${panelUrl(created.key)}\n`, emit);
      if (created.status !== 'done') {
        await this.options.watch(session, emit);
      }
    } else {
      await this.chat(session, text, undefined, emit);
    }
  }

  commands(session: Session, emit: (note: JsonRpc) => void): void {
    const availableCommands = [
      ...this.options.skills.map((skill) => ({ name: skill.name, description: skill.description })),
      { name: 'step', description: 'Run a pipeline step. The next word is the step name.' },
      { name: 'resume', description: 'Run the failed step again.' },
      { name: 'replay', description: 'Restart this feature from requirements. The rest is the new prompt.' },
      {
        name: 'review',
        description: 'Start a code review of this directory, or of a directory named after the command.',
      },
    ];
    emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: session.id, update: { sessionUpdate: 'available_commands_update', availableCommands } },
    });
  }

  private async review(session: Session, rest: string, emit: (note: JsonRpc) => void): Promise<void> {
    const path = this.reviewPath(session, rest);
    const created = await this.options.api.create({ path, prompt: reviewPrompt(rest) });
    session.runKey = created.key;
    this.options.name(session, created.key, emit);
    this.options.chunk(session, `${created.key} code review started\n`, emit);
    if (created.status !== 'done') {
      await this.options.watch(session, emit);
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
    this.options.name(session, started.key, emit);
    this.options.chunk(session, `${started.key} replay started\n`, emit);
    if (started.status !== 'done') {
      await this.options.watch(session, emit);
    }
  }

  private async continueRun(session: Session, rest: string, emit: (note: JsonRpc) => void): Promise<void> {
    const key = await this.bindRun(session);
    const prompt = rest.trim();
    const started = await this.options.api.resume(key, prompt ? { prompt } : {});
    this.options.name(session, started.key, emit);
    this.options.chunk(session, `${started.key} resumed\n`, emit);
    if (started.status !== 'done') {
      await this.options.watch(session, emit);
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
    this.options.name(session, started.key, emit);
    this.options.chunk(session, `${started.key} ${name} started\n`, emit);
    if (started.status !== 'done') {
      await this.options.watch(session, emit);
    }
  }

  private async chat(
    session: Session,
    text: string,
    skill: string | undefined,
    emit: (note: JsonRpc) => void,
  ): Promise<void> {
    if (!session.runKey) {
      throw new Error('start the feature with a prompt first');
    }
    try {
      const result = await this.options.api.chat(session.runKey, {
        prompt: text,
        skill,
        cwd: this.options.visible(session.cwd),
        mcpServers: session.mcpServers,
      });
      const body = result.text.trimEnd();
      this.options.chunk(session, body.length > 0 ? `${body}\n` : '\n', emit);
    } catch (error) {
      if (session.cancelled) {
        return;
      }
      throw error;
    }
  }

  private reviewPath(session: Session, rest: string): string {
    const first = rest.split(/\s+/)[0] ?? '';
    if (!looksLikePath(first)) {
      return this.options.visible(session.cwd);
    }
    return this.options.visible(isAbsolute(first) ? first : resolve(session.cwd, first));
  }

  private gitProjects(session: Session): string[] {
    const names: string[] = [];
    for (const folder of session.folders) {
      if (!existsSync(join(folder, '.git'))) {
        continue;
      }
      const name = basename(this.options.visible(folder));
      if (name === 'checkouts' || name.startsWith('.') || name.startsWith('run-') || !CHECKOUT_NAME.test(name)) {
        continue;
      }
      names.push(name);
    }
    return [...new Set(names)].sort();
  }

  private skill(name: string): SkillCommand | undefined {
    return this.options.skills.find((skill) => skill.name === name);
  }
}

const PANEL_ORIGIN = 'http://127.0.0.1:3921';

export function panelUrl(runKey: string | null): string {
  return runKey ? `${PANEL_ORIGIN}/runs/${encodeURIComponent(runKey)}` : PANEL_ORIGIN;
}

export function parseCommand(text: string): Command | null {
  const match = /^\/([A-Za-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), rest: (match[2] ?? '').trim() } : null;
}

export function promptText(value: unknown): string {
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
