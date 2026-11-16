import type { OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { UserSettingRepository } from '../history/user-setting.repository';
import { BacklogStartPort } from '../pipeline/backlog/backlog-start-port';
import { CommandService } from '../pipeline/command.service';
import { RunCommandsService } from './run-commands.service';

/** Starts a backlog task as `POST /runs` starts a run: the same plan, the same command, the owner as the person. */
@Injectable()
export class BacklogStart implements OnModuleInit {
  constructor(
    private readonly port: BacklogStartPort,
    private readonly runs: RunCommandsService,
    private readonly commands: CommandService,
    private readonly settings: UserSettingRepository,
  ) {}

  onModuleInit(): void {
    this.port.register(async ({ key, prompt, projects, owner }) => {
      const agents = (await this.settings.read(owner))?.agents ?? null;
      const plan = await this.runs.plan({ key, prompt, projects }, owner);
      await this.commands.submit(
        'start',
        plan.key,
        { ...plan },
        { create: { targetPath: null, startedBy: owner, agents } },
      );
    });
  }
}
