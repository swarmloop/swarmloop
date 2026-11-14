import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import type { ConnectionCard, IntegrationCardsView, SignInView } from '../contract/connections';
import { Actor } from './actor.decorator';
import { ConnectionCatalog } from './connection-catalog';
import { SignInSessions } from './sign-in-sessions.service';

/** The cards of the Connections page, and the save, test and disconnect of one person's credential. */
@Controller('connections/integrations')
export class IntegrationConnectionsController {
  constructor(
    private readonly catalog: ConnectionCatalog,
    private readonly signIns: SignInSessions,
  ) {}

  @Get()
  list(@Actor() actor: string | null): Promise<IntegrationCardsView> {
    return this.catalog.list(actor);
  }

  @Put(':id')
  save(
    @Param('id') id: string,
    @Body() body: { fields?: Record<string, string> },
    @Actor() actor: string | null,
  ): Promise<ConnectionCard> {
    return this.catalog.save(id, actor, body.fields ?? {});
  }

  @Post(':id/test')
  test(@Param('id') id: string, @Actor() actor: string | null): Promise<ConnectionCard> {
    return this.catalog.test(id, actor);
  }

  @Delete(':id')
  disconnect(@Param('id') id: string, @Actor() actor: string | null): Promise<{ ok: true }> {
    return this.catalog.disconnect(id, actor);
  }

  @Post(':id/sign-in')
  startSignIn(@Param('id') id: string, @Actor() actor: string | null): Promise<SignInView> {
    return this.signIns.start(id, actor);
  }

  @Get(':id/sign-in/:session')
  pollSignIn(@Param('id') id: string, @Param('session') session: string, @Actor() actor: string | null): SignInView {
    return this.signIns.poll(id, session, actor);
  }

  @Post(':id/sign-in/:session/code')
  submitSignInCode(
    @Param('id') id: string,
    @Param('session') session: string,
    @Body() body: { code?: string },
    @Actor() actor: string | null,
  ): SignInView {
    return this.signIns.submit(id, session, actor, body.code ?? '');
  }
}
