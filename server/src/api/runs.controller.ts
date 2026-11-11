import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  AddProjectBody,
  AnswersBody,
  ChatBody,
  ChatView,
  CreateRunBody,
  FlowView,
  HistoryView,
  LockShellBody,
  OpenShellBody,
  ProjectsView,
  RemovedRunView,
  ReplayBody,
  ResumeBody,
  RewindBody,
  RewindView,
  RunRef,
  RunsView,
  ShellFeature,
  ShellMatch,
  ShellStatusView,
  SnapshotsView,
  StartStepBody,
  StepView,
  TicketKeysBody,
  TicketKeysView,
} from '../contract/api';
import { Actor } from '../auth/actor.decorator';
import type { CommandInput, CommandReceipt, CommandType } from '../contract/command';
import type { StepEventPage } from '../contract/step-events';
import { CommandService } from '../pipeline/command.service';
import type { SubmitOptions } from '../pipeline/command.service';
import type { ReplayPayload, ShellPayload, StepPayload } from './command-handlers';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';
import { ShellService } from './shell.service';

/** A started run is accepted; anything else the run answers with is OK. */
export function httpStatus(result: RunRef): number {
  return result.status === 'started' ? 202 : 200;
}

@Controller()
export class RunsController {
  constructor(
    private readonly queries: RunQueriesService,
    private readonly runs: RunCommandsService,
    private readonly commands: CommandService,
    private readonly shell: ShellService,
  ) {}

  @Get('runs')
  list(): Promise<RunsView> {
    return this.queries.list();
  }

  @Get('runs/:key/history')
  history(@Param('key') key: string): Promise<HistoryView> {
    return this.queries.readHistory(key);
  }

  @Get('runs/:key/events')
  events(
    @Param('key') key: string,
    @Query('step') step?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<StepEventPage> {
    return this.queries.stepEventPage(key, { step, after, limit });
  }

  @Get('runs/:key/steps/:step/log')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  stepLog(
    @Param('key') key: string,
    @Param('step') step: string,
    @Query('attempt') attempt?: string,
    @Query('tail') tail?: string,
    @Query('from') from?: string,
    @Query('command') command?: string,
  ): Promise<string> {
    return this.queries.stepLog(key, step, attempt || null, { tail, from, command });
  }

  @Get('runs/:key/steps/:step')
  step(@Param('key') key: string, @Param('step') step: string): Promise<StepView> {
    return this.queries.step(key, step);
  }

  @Get('runs/:key')
  flow(@Param('key') key: string): Promise<FlowView> {
    return this.queries.flow(key);
  }

  @Post('runs/ticket-keys')
  ticketKeys(@Body() body: TicketKeysBody): Promise<TicketKeysView> {
    return this.runs.ticketKeys(body);
  }

  @Post('runs/shell')
  async openShell(
    @Body() body: OpenShellBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<(ShellFeature | { matches: ShellMatch[] }) & Partial<CommandReceipt>> {
    const found = await this.shell.locate(body.path ?? '');
    if ('matches' in found) {
      return found;
    }
    const payload: ShellPayload = { op: 'open', path: found.cwd };
    return this.dispatch('shell', found.key, payload, idempotencyKey, {
      create: found.created ? { targetPath: found.cwd } : undefined,
    });
  }

  @Get('runs/:key/shell')
  shellFeature(@Param('key') key: string): Promise<ShellFeature> {
    return this.shell.describe(key);
  }

  @Post('runs/:key/shell/lock')
  lockShell(
    @Param('key') key: string,
    @Body() body: LockShellBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ShellStatusView & CommandReceipt> {
    return this.dispatch('shell', key, { op: 'lock', container: body.container ?? '' }, idempotencyKey, {
      expectedRevision: body.expectedRevision,
    });
  }

  @Post('runs/:key/shell/unlock')
  unlockShell(
    @Param('key') key: string,
    @Body() body?: CommandInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ShellStatusView & CommandReceipt> {
    return this.dispatch('shell', key, { op: 'unlock' }, idempotencyKey, { expectedRevision: body?.expectedRevision });
  }

  @Get('runs/:key/snapshots')
  snapshots(@Param('key') key: string): Promise<SnapshotsView> {
    return this.shell.snapshots(key);
  }

  @Post('runs/:key/rewind')
  rewind(
    @Param('key') key: string,
    @Body() body: RewindBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RewindView & CommandReceipt> {
    return this.dispatch('rewind', key, { id: body.id }, idempotencyKey, { expectedRevision: body.expectedRevision });
  }

  @Post('runs')
  async create(
    @Body() body: CreateRunBody,
    @Res({ passthrough: true }) response: { status(code: number): void },
    @Actor() actor: string | null,
  ): Promise<RunRef & CommandReceipt> {
    const plan = await this.runs.plan(body);
    const result = await this.dispatch<RunRef>('start', plan.key, { ...plan }, undefined, {
      create: { targetPath: null, startedBy: actor },
      expectedRevision: body.expectedRevision,
    });
    response.status(httpStatus(result));
    return result;
  }

  @Post('runs/:key/answers')
  answers(
    @Param('key') key: string,
    @Body() body: AnswersBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<FlowView & CommandReceipt> {
    return this.dispatch('answer', key, { answers: body.answers }, idempotencyKey, {
      expectedRevision: body.expectedRevision,
    });
  }

  @Post('runs/:key/chat')
  chatWith(
    @Param('key') key: string,
    @Body() body: ChatBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ChatView & CommandReceipt> {
    const { expectedRevision, ...payload } = body;
    return this.dispatch('chat', key, payload, idempotencyKey, { expectedRevision });
  }

  @Post('runs/:key/steps/:step')
  async startStep(
    @Param('key') key: string,
    @Param('step') step: string,
    @Body() body: StartStepBody,
    @Res({ passthrough: true }) response: { status(code: number): void },
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RunRef & CommandReceipt> {
    const { expectedRevision, ...rest } = body ?? {};
    const payload: StepPayload = { step, body: rest };
    const result = await this.dispatch<RunRef>('step', key, payload, idempotencyKey, { expectedRevision });
    response.status(httpStatus(result));
    return result;
  }

  @Post('runs/:key/steps/:step/replay')
  async replay(
    @Param('key') key: string,
    @Param('step') step: string,
    @Body() body: ReplayBody,
    @Res({ passthrough: true }) response: { status(code: number): void },
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RunRef & CommandReceipt> {
    const payload: ReplayPayload = { step, prompt: body.prompt ?? '', phases: body.phases };
    const result = await this.dispatch<RunRef>('replay', key, payload, idempotencyKey, {
      expectedRevision: body.expectedRevision,
    });
    response.status(httpStatus(result));
    return result;
  }

  @Post('runs/:key/stop')
  async stop(
    @Param('key') key: string,
    @Res({ passthrough: true }) response: { status(code: number): void },
    @Body() body?: CommandInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RunRef & CommandReceipt> {
    const result = await this.dispatch<RunRef>('stop', key, {}, idempotencyKey, {
      expectedRevision: body?.expectedRevision,
    });
    response.status(httpStatus(result));
    return result;
  }

  @Delete('runs/:key')
  remove(
    @Param('key') key: string,
    @Body() body?: CommandInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RemovedRunView & CommandReceipt> {
    return this.dispatch('remove', key, {}, idempotencyKey, { expectedRevision: body?.expectedRevision });
  }

  @Post('runs/:key/rebase')
  async rebase(
    @Param('key') key: string,
    @Res({ passthrough: true }) response: { status(code: number): void },
    @Body() body?: CommandInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RunRef & CommandReceipt> {
    const result = await this.dispatch<RunRef>('rebase', key, {}, idempotencyKey, {
      expectedRevision: body?.expectedRevision,
    });
    response.status(httpStatus(result));
    return result;
  }

  @Post('runs/:key/projects')
  addProject(
    @Param('key') key: string,
    @Body() body: AddProjectBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ProjectsView & CommandReceipt> {
    return this.dispatch('projects', key, { name: body.name ?? '' }, idempotencyKey, {
      expectedRevision: body.expectedRevision,
    });
  }

  @Post('runs/:key/resume')
  async resume(
    @Param('key') key: string,
    @Body() body: ResumeBody,
    @Res({ passthrough: true }) response: { status(code: number): void },
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RunRef & CommandReceipt> {
    const result = await this.dispatch<RunRef>('resume', key, { prompt: body?.prompt }, idempotencyKey, {
      expectedRevision: body?.expectedRevision,
    });
    response.status(httpStatus(result));
    return result;
  }

  /** Every mutating route goes through here: accept the command, wait for its handler, add the receipt. */
  private async dispatch<T extends object>(
    type: CommandType,
    key: string,
    payload: Record<string, unknown> | object,
    idempotencyKey: string | undefined,
    options: Pick<SubmitOptions, 'create'> & { expectedRevision?: unknown } = {},
  ): Promise<T & CommandReceipt> {
    const { expectedRevision, create } = options;
    if (expectedRevision !== undefined && !Number.isInteger(expectedRevision)) {
      throw new BadRequestException('expectedRevision is not a count');
    }
    const { value, receipt } = await this.commands.submit<T>(type, key, payload as Record<string, unknown>, {
      idempotencyKey: idempotencyKey?.trim() || undefined,
      expectedRevision: expectedRevision as number | undefined,
      create,
    });
    return { ...value, ...receipt };
  }
}
