import { existsSync } from 'fs';
import { basename, isAbsolute, join, resolve } from 'path';
import { CHECKOUT_NAME } from '../core/checkout-name';
import { nestCheckout } from './paths';
import type { ServerApi } from './server-api';
import type { Session } from './sessions';

export interface SkillCommand {
  name: string;
  description: string;
}

interface Command {
  name: string;
  rest: string;
}

interface CommandOptions {
  api: ServerApi;
  skills: SkillCommand[];
  repoRoot: string;
  checkoutsRoot?: string;
}

interface CommandEvents {
  name(session: Session, title: string): void;
  chunk(session: Session, text: string): void;
  watch(session: Session): Promise<void>;
  panelUrl(runKey: string | null): string;
}

export class Commands {
  constructor(
    private readonly options: CommandOptions,
    private readonly events: CommandEvents,
  ) {}

  async prompt(session: Session, params: Record<string, unknown>): Promise<void> {
    session.cancelled = false;
    const text = promptText(params.prompt);
    if (!text) {
      throw new Error('prompt is missing');
    }
    const command = parseCommand(text);
    if (command?.name === 'review') {
      await this.review(session, command.rest);
    } else if (command?.name === 'replay') {
      await this.replay(session, command.rest);
    } else if (command?.name === 'resume') {
      await this.continueRun(session, command.rest);
    } else if (command?.name === 'step') {
      await this.runStep(session, command.rest);
    } else if (command && this.skill(command.name)) {
      await this.chat(session, command.rest || 'Follow the skill.', command.name);
    } else if (command) {
      this.events.chunk(session, `unknown command /${command.name}\n`);
    } else if (!session.runKey) {
      const projects = this.gitProjects(session);
      if (projects.length === 0) {
        throw new Error('project is missing');
      }
      const created = await this.options.api.create({ prompt: text, projects });
      session.runKey = created.key;
      // PhpStorm locks the first title. Name the chat before any text, or the prompt stays.
      this.events.name(session, created.key);
      this.events.chunk(session, `${created.key} started\n${this.events.panelUrl(created.key)}\n`);
      if (created.status !== 'done') {
        await this.events.watch(session);
      }
    } else {
      await this.chat(session, text, undefined);
    }
  }

  private async review(session: Session, rest: string): Promise<void> {
    const path = this.reviewPath(session, rest);
    const created = await this.options.api.create({ path, prompt: reviewPrompt(rest) });
    session.runKey = created.key;
    this.events.name(session, created.key);
    this.events.chunk(session, `${created.key} code review started\n`);
    if (created.status !== 'done') {
      await this.events.watch(session);
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

  private async replay(session: Session, rest: string): Promise<void> {
    if (!session.runKey) {
      throw new Error('feature is missing');
    }
    if (!rest.trim()) {
      throw new Error('prompt is missing');
    }
    const started = await this.options.api.replay(session.runKey, 'requirements', { prompt: rest });
    this.events.name(session, started.key);
    this.events.chunk(session, `${started.key} replay started\n`);
    if (started.status !== 'done') {
      await this.events.watch(session);
    }
  }

  private async continueRun(session: Session, rest: string): Promise<void> {
    const key = await this.bindRun(session);
    const prompt = rest.trim();
    const started = await this.options.api.resume(key, prompt ? { prompt } : {});
    this.events.name(session, started.key);
    this.events.chunk(session, `${started.key} resumed\n`);
    if (started.status !== 'done') {
      await this.events.watch(session);
    }
  }

  private async runStep(session: Session, rest: string): Promise<void> {
    const key = await this.bindRun(session);
    const [name, ...tail] = rest.split(/\s+/).filter((part) => part.length > 0);
    if (!name) {
      throw new Error('step is missing');
    }
    const prompt = tail.join(' ').trim();
    const started = await this.options.api.step(key, name, { prompt: prompt || undefined });
    this.events.name(session, started.key);
    this.events.chunk(session, `${started.key} ${name} started\n`);
    if (started.status !== 'done') {
      await this.events.watch(session);
    }
  }

  private async chat(session: Session, text: string, skill: string | undefined): Promise<void> {
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
      this.events.chunk(session, body.length > 0 ? `${body}\n` : '\n');
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
      return this.visible(session.cwd);
    }
    const chosen = isAbsolute(first) ? first : resolve(session.cwd, first);
    return this.visible(chosen);
  }

  private visible(hostPath: string): string {
    return nestCheckout(hostPath, this.options.repoRoot, this.options.checkoutsRoot);
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

  private skill(name: string): SkillCommand | undefined {
    return this.options.skills.find((skill) => skill.name === name);
  }
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
