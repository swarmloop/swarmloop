import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import type { BacklogChatView, PostBacklogMessageBody } from '../contract/backlog-chat';
import { BacklogChatService } from './backlog-chat.service';

@Controller('backlogs')
export class BacklogChatController {
  constructor(private readonly chat: BacklogChatService) {}

  @Post(':name/messages')
  post(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Body() body: PostBacklogMessageBody,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<BacklogChatView> {
    return this.chat.post(actor, name, body?.text, idempotencyKey);
  }

  @Get(':name/messages')
  messages(@Param('name') name: string): Promise<BacklogChatView> {
    return this.chat.chat(name);
  }

  @Post(':name/turns/resume')
  resume(@Actor() actor: string | null, @Param('name') name: string): Promise<BacklogChatView> {
    return this.chat.resume(actor, name);
  }
}
