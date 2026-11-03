import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
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
} from '../contract/api';
import { ChatService } from './chat.service';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';
import { RunRebaseService } from './run-rebase.service';
import { ShellService } from './shell.service';

/** A started run is accepted; anything else the run answers with is OK. */
export function httpStatus(result: RunRef): number {
  return result.status === 'started' ? 202 : 200;
}

@Controller()
export class RunsController {
  constructor(
    private readonly queries: RunQueriesService,
    private readonly commands: RunCommandsService,
    private readonly rebases: RunRebaseService,
    private readonly chat: ChatService,
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

  @Get('runs/:key/steps/:step')
  step(@Param('key') key: string, @Param('step') step: string): Promise<StepView> {
    return this.queries.step(key, step);
  }

  @Get('runs/:key')
  flow(@Param('key') key: string): Promise<FlowView> {
    return this.queries.flow(key);
  }

  @Post('runs/shell')
  openShell(@Body() body: OpenShellBody): Promise<ShellFeature | { matches: ShellMatch[] }> {
    return this.shell.open(body.path ?? '');
  }

  @Get('runs/:key/shell')
  shellFeature(@Param('key') key: string): Promise<ShellFeature> {
    return this.shell.describe(key);
  }

  @Post('runs/:key/shell/lock')
  lockShell(@Param('key') key: string, @Body() body: LockShellBody): Promise<ShellStatusView> {
    return this.shell.lock(key, body.container ?? '');
  }

  @Post('runs/:key/shell/unlock')
  unlockShell(@Param('key') key: string): Promise<ShellStatusView> {
    return this.shell.unlock(key);
  }

  @Get('runs/:key/snapshots')
  snapshots(@Param('key') key: string): Promise<SnapshotsView> {
    return this.shell.snapshots(key);
  }

  @Post('runs/:key/rewind')
  rewind(@Param('key') key: string, @Body() body: RewindBody): Promise<RewindView> {
    return this.shell.rewind(key, Number(body.id));
  }

  @Post('runs')
  async create(
    @Body() body: CreateRunBody,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ): Promise<RunRef> {
    const result = await this.commands.start(body);
    response.status(httpStatus(result));
    return result;
  }

  @Post('runs/:key/answers')
  answers(@Param('key') key: string, @Body() body: AnswersBody): Promise<FlowView> {
    return this.commands.answers(key, body);
  }

  @Post('runs/:key/chat')
  chatWith(@Param('key') key: string, @Body() body: ChatBody): Promise<ChatView> {
    return this.chat.speak(key, body);
  }

  @Post('runs/:key/steps/:step')
  async startStep(
    @Param('key') key: string,
    @Param('step') step: string,
    @Body() body: StartStepBody,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ): Promise<RunRef> {
    const result = await this.commands.startStep(key, step, body);
    response.status(httpStatus(result));
    return result;
  }

  @Post('runs/:key/steps/:step/replay')
  async replay(
    @Param('key') key: string,
    @Param('step') step: string,
    @Body() body: ReplayBody,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ): Promise<RunRef> {
    const result = await this.commands.replay(key, step, body.prompt ?? '', body.phases);
    response.status(httpStatus(result));
    return result;
  }

  @Post('runs/:key/stop')
  async stop(
    @Param('key') key: string,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ): Promise<RunRef> {
    const result = await this.commands.stop(key);
    response.status(httpStatus(result));
    return result;
  }

  @Delete('runs/:key')
  remove(@Param('key') key: string): Promise<RemovedRunView> {
    return this.commands.remove(key);
  }

  @Post('runs/:key/rebase')
  async rebase(
    @Param('key') key: string,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ): Promise<RunRef> {
    const result = await this.rebases.rebase(key);
    response.status(httpStatus(result));
    return result;
  }

  @Post('runs/:key/projects')
  addProject(@Param('key') key: string, @Body() body: AddProjectBody): Promise<ProjectsView> {
    return this.commands.addProject(key, body.name ?? '');
  }

  @Post('runs/:key/resume')
  async resume(
    @Param('key') key: string,
    @Body() body: ResumeBody,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ): Promise<RunRef> {
    const result = await this.commands.resume(key, body?.prompt);
    response.status(httpStatus(result));
    return result;
  }
}
