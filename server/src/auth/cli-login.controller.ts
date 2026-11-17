import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AppConfig } from '../config/env';
import type { CliLoginPoll, CliLoginStart, CliLoginStarted } from '../contract/people';
import { CliLogins } from './cli-logins';
import { Public } from './public.decorator';

/** The CLI's side of its login: it starts one, shows the code and polls. It holds no token until a person approves. */
@Public()
@Controller('auth/cli')
export class CliLoginController {
  constructor(
    private readonly config: AppConfig,
    private readonly logins: CliLogins,
  ) {}

  @Post('logins')
  start(@Body() body: CliLoginStart): CliLoginStarted {
    if (typeof body?.machine !== 'string' || !body.machine.trim()) {
      throw new BadRequestException('machine must be a name');
    }
    const login = this.logins.start(body.machine);
    const base = this.config.env.SWARMLOOP_PUBLIC_URL.replace(/\/$/, '');
    return { id: login.id, code: login.code, url: `${base}/cli-login?code=${login.code}`, expiresAt: login.expiresAt };
  }

  @Get('logins/:id')
  poll(@Param('id') id: string): CliLoginPoll {
    return this.logins.poll(id);
  }
}
