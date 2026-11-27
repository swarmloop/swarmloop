import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import type { CommandView } from '../contract/command';
import { CommandService } from '../pipeline/command.service';

@Controller('commands')
export class CommandsController {
  constructor(private readonly commands: CommandService) {}

  @Get(':id')
  async view(@Actor() actor: string | null, @Param('id') id: string): Promise<CommandView> {
    const view = await this.commands.view(id, actor);
    if (!view) throw new NotFoundException('the command is missing');
    return view;
  }
}
