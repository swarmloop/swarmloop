import { Controller, Delete, ForbiddenException, Post } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import { PeopleService } from '../auth/people.service';
import type { ServerState } from '../contract/server-pause';
import { ContainerGate } from '../sandbox/container-gate';

@Controller('server')
export class ServerController {
  constructor(
    private readonly gate: ContainerGate,
    private readonly people: PeopleService,
  ) {}

  @Post('pause')
  async pause(@Actor() actor: string | null): Promise<ServerState> {
    await this.assertAdmin(actor);
    this.gate.pause();
    return { paused: true };
  }

  @Delete('pause')
  async resume(@Actor() actor: string | null): Promise<ServerState> {
    await this.assertAdmin(actor);
    this.gate.resume();
    return { paused: false };
  }

  private async assertAdmin(actor: string | null): Promise<void> {
    if (!actor || !(await this.people.isAdmin(actor))) {
      throw new ForbiddenException('only an admin can pause the server');
    }
  }
}
