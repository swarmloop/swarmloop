import { Body, Controller, Get, Put } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import { requirePerson } from '../auth/connection-catalog';
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
    return this.settings.save(requirePerson(actor), body);
  }
}
