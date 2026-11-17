import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import type { FlowView } from '../contract/api';
import type { CommandReceipt } from '../contract/command';
import type { PlanChatBody } from '../contract/plan-chat';
import { PlanChatService } from './plan-chat.service';

@Controller()
export class PlanChatController {
  constructor(private readonly planChat: PlanChatService) {}

  /** A message to the planner of the run, from the person the request acts for. */
  @Post('runs/:key/plan-chat')
  send(
    @Param('key') key: string,
    @Body() body: Partial<PlanChatBody> | undefined,
    @Actor() actor: string | null,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<FlowView & CommandReceipt> {
    const author = actor && actor !== 'machine' ? actor : null;
    return this.planChat.send(key, body?.message, author, idempotencyKey, body?.attachments);
  }
}
