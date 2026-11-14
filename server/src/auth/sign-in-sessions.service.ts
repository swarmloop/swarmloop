import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { redact, rememberSecret } from '../core/redact';
import type { SignInView } from '../contract/connections';
import type { Connection, SignInFlow } from '../integrations/connection';
import { CliSignIn, type CliSignInRun } from '../sandbox/cli-sign-in';
import { ConnectionCatalog, CONNECTIONS, requirePerson } from './connection-catalog';

/** A session that ended stays for a short time, so the page can read how it ended. */
const RETAIN_MS = 5 * 60 * 1000;
const MESSAGE_LINES = 5;

interface Session {
  id: string;
  login: string;
  connection: Connection;
  flow: SignInFlow;
  run: CliSignInRun;
  deadline: number;
  /** Ends the session at its deadline even when nobody asks about it. Cleared when the session ends. */
  timer?: ReturnType<typeof setTimeout>;
  phase: 'running' | 'done' | 'failed';
  message: string | null;
  endedAt: number | null;
  codeSent: boolean;
}

/**
 * The CLI sign-ins that are under way, in memory. Each belongs to the person who started it and ends by itself:
 * with the CLI's exit, or at its deadline. A credential is stored only through the catalog, after its test passes.
 */
@Injectable()
export class SignInSessions implements OnModuleDestroy {
  private readonly sessions = new Map<string, Session>();

  constructor(
    @Inject(CONNECTIONS) private readonly connections: readonly Connection[],
    private readonly cli: CliSignIn,
    private readonly catalog: ConnectionCatalog,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  async start(id: string, actor: string | null): Promise<SignInView> {
    const login = requirePerson(actor);
    this.sweep();
    const connection = this.connections.find((one) => one.id === id);
    if (!connection) {
      throw new NotFoundException(`${id} is not a connection`);
    }
    const flow = connection.signIn?.();
    if (!flow) {
      throw new BadRequestException(`${connection.label} has no sign-in`);
    }
    await this.replaceOlder(login, id);
    const key = randomUUID();
    const run = await this.cli.run({ runtime: id, command: flow.command(), hosts: flow.hosts, key }).catch((error) => {
      throw new BadRequestException(this.masked(error instanceof Error ? error.message : String(error)));
    });
    const session: Session = {
      id: key,
      login,
      connection,
      flow,
      run,
      deadline: this.clock.now() + flow.timeoutMs,
      phase: 'running',
      message: null,
      endedAt: null,
      codeSent: false,
    };
    session.timer = setTimeout(() => this.end(session, 'failed', 'the sign-in timed out'), flow.timeoutMs);
    this.sessions.set(key, session);
    void run.exited.then((code) => this.finish(session, code));
    return this.view(session);
  }

  poll(id: string, sessionId: string, actor: string | null): SignInView {
    return this.view(this.own(id, sessionId, actor));
  }

  /** Hands the code the person typed to the CLI that asked for it. */
  submit(id: string, sessionId: string, actor: string | null, code: string): SignInView {
    const session = this.own(id, sessionId, actor);
    if (session.phase !== 'running') {
      throw new BadRequestException('the sign-in has ended');
    }
    if (code.trim() === '') {
      throw new BadRequestException('type the code the page shows');
    }
    rememberSecret(code);
    session.codeSent = true;
    session.run.write(`${code}\n`);
    return this.view(session);
  }

  async onModuleDestroy(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.end(session, 'failed', 'the server stopped');
    }
    await Promise.all([...this.sessions.values()].map((session) => session.run.stop()));
    this.sessions.clear();
  }

  private own(id: string, sessionId: string, actor: string | null): Session {
    const login = requirePerson(actor);
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || session.connection.id !== id) {
      throw new NotFoundException('there is no such sign-in');
    }
    if (session.login !== login) {
      throw new ForbiddenException('this sign-in belongs to someone else');
    }
    return session;
  }

  /** Ends the sessions past their deadline and drops the ones that ended a while ago. */
  private sweep(): void {
    const now = this.clock.now();
    for (const session of this.sessions.values()) {
      if (session.phase === 'running' && now >= session.deadline) {
        this.end(session, 'failed', 'the sign-in timed out');
      } else if (session.endedAt !== null && now - session.endedAt >= RETAIN_MS) {
        this.sessions.delete(session.id);
      }
    }
  }

  private async replaceOlder(login: string, id: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.login === login && session.connection.id === id) {
        this.sessions.delete(session.id);
        this.end(session, 'failed', 'a newer sign-in replaced this one');
        await session.run.stop();
      }
    }
  }

  private async finish(session: Session, code: number | null): Promise<void> {
    if (session.phase !== 'running') {
      return;
    }
    // The CLI has ended: the deadline must not cut in while its credential is tested and stored.
    clearTimeout(session.timer);
    const { fields } = session.flow.parse(session.run.output());
    if (fields) {
      session.connection.secrets(fields).forEach(rememberSecret);
    }
    if (code !== 0 || !fields) {
      this.end(session, 'failed', this.lastLines(session.run.output()));
      return;
    }
    try {
      await this.catalog.save(session.connection.id, session.login, fields);
      this.end(session, 'done', null);
    } catch (error) {
      this.end(session, 'failed', this.masked(error instanceof Error ? error.message : String(error)));
    }
  }

  private end(session: Session, state: 'done' | 'failed', message: string | null): void {
    if (session.phase !== 'running') {
      return;
    }
    clearTimeout(session.timer);
    session.phase = state;
    session.message = message;
    session.endedAt = this.clock.now();
    void session.run.stop();
  }

  private lastLines(output: string): string {
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-MESSAGE_LINES);
    return this.masked(lines.join('\n') || 'the sign-in ended without a credential');
  }

  private masked(text: string): string {
    return redact(text, this.config.env);
  }

  private view(session: Session): SignInView {
    const shown = session.flow.parse(session.run.output());
    const state =
      session.phase === 'running' ? (shown.asksForCode && !session.codeSent ? 'code' : 'waiting') : session.phase;
    return { id: session.id, state, link: shown.link, code: shown.code, message: session.message };
  }
}
