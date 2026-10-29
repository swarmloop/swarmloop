import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
import { ChatBody, ChatService } from './chat.service';
import { RunsService } from './runs.service';
import { ShellFeature, ShellService } from './shell.service';

interface StatusResponse {
  status(code: number): void;
}

@Controller()
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly chat: ChatService,
    private readonly shell: ShellService,
  ) {}

  @Get('runs')
  list(): Promise<{ runs: { key: string; name: string; status: string; currentStep: string; createdAt: string; updatedAt: string; stepStartedAt: string | null; durationMs: number; usd: number }[] }> {
    return this.runs.list();
  }

  @Get('runs/:key/history')
  history(@Param('key') key: string): ReturnType<RunsService['readHistory']> {
    return this.runs.readHistory(key);
  }

  @Get('runs/:key/steps/:step')
  step(@Param('key') key: string, @Param('step') step: string): ReturnType<RunsService['step']> {
    return this.runs.step(key, step);
  }

  @Get('runs/:key')
  flow(@Param('key') key: string): ReturnType<RunsService['flow']> {
    return this.runs.flow(key);
  }

  @Post('runs/shell')
  openShell(@Body() body: { path?: string }): Promise<ShellFeature | { matches: { key: string; status: string; currentStep: string }[] }> {
    return this.shell.open(body.path ?? '');
  }

  @Get('runs/:key/shell')
  shellFeature(@Param('key') key: string): Promise<ShellFeature> {
    return this.shell.describe(key);
  }

  @Post('runs/:key/shell/lock')
  lockShell(@Param('key') key: string, @Body() body: { container?: string }): Promise<{ status: string }> {
    return this.shell.lock(key, body.container ?? '');
  }

  @Post('runs/:key/shell/unlock')
  unlockShell(@Param('key') key: string): Promise<{ status: string }> {
    return this.shell.unlock(key);
  }

  @Get('runs/:key/snapshots')
  snapshots(@Param('key') key: string): Promise<{ snapshots: { id: number; step: string; at: string }[] }> {
    return this.shell.snapshots(key);
  }

  @Post('runs/:key/rewind')
  rewind(@Param('key') key: string, @Body() body: { id?: number }): Promise<{ step: string }> {
    return this.shell.rewind(key, Number(body.id));
  }

  @Post('runs')
  async create(
    @Body() body: { key?: string; prompt?: string; path?: string; projects?: string[]; phases?: string[] },
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<{ key: string; status: string }> {
    const result = await this.runs.start(body);
    response.status(result.http);
    return result.body;
  }

  @Post('runs/:key/answers')
  answers(
    @Param('key') key: string,
    @Body() body: { answers?: { kind?: string; id?: string; body?: string }[] },
  ): ReturnType<RunsService['answers']> {
    return this.runs.answers(key, body);
  }

  @Post('runs/:key/chat')
  chatWith(@Param('key') key: string, @Body() body: ChatBody): Promise<{ text: string }> {
    return this.chat.speak(key, body);
  }

  @Post('runs/:key/steps/:step')
  async startStep(
    @Param('key') key: string,
    @Param('step') step: string,
    @Body() body: { prompt?: string; path?: string },
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<{ key: string; status: string }> {
    const result = await this.runs.startStep(key, step, body);
    response.status(result.http);
    return result.body;
  }

  @Post('runs/:key/steps/:step/replay')
  async replay(
    @Param('key') key: string,
    @Param('step') step: string,
    @Body() body: { prompt?: string; phases?: string[] },
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<{ key: string; status: string }> {
    const result = await this.runs.replay(key, step, body.prompt ?? '', body.phases);
    response.status(result.http);
    return result.body;
  }

  @Post('runs/:key/stop')
  async stop(@Param('key') key: string, @Res({ passthrough: true }) response: StatusResponse): Promise<{ key: string; status: string }> {
    const result = await this.runs.stop(key);
    response.status(result.http);
    return result.body;
  }

  @Delete('runs/:key')
  remove(@Param('key') key: string): Promise<{ key: string }> {
    return this.runs.remove(key);
  }

  @Post('runs/:key/rebase')
  async rebase(@Param('key') key: string, @Res({ passthrough: true }) response: StatusResponse): Promise<{ key: string; status: string }> {
    const result = await this.runs.rebase(key);
    response.status(result.http);
    return result.body;
  }

  @Post('runs/:key/projects')
  addProject(@Param('key') key: string, @Body() body: { name?: string }): Promise<{ projects: string[]; applied: boolean }> {
    return this.runs.addProject(key, body.name ?? '');
  }

  @Post('runs/:key/resume')
  async resume(
    @Param('key') key: string,
    @Body() body: { prompt?: string },
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<{ key: string; status: string }> {
    const result = await this.runs.resume(key, body?.prompt);
    response.status(result.http);
    return result.body;
  }
}
