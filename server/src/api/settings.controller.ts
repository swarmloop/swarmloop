import { Body, Controller, ForbiddenException, Get, Put } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import type { SettingsView } from '../contract/settings';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  read(@Actor() actor: string | null): Promise<SettingsView> {
    return this.settings.view(actor);
  }

  @Put()
  save(@Actor() actor: string | null, @Body() body: unknown): Promise<SettingsView> {
    if (!actor || actor === 'machine') {
      throw new ForbiddenException('the machine token has no personal settings');
    }
    return this.settings.save(actor, body);
  }
}
