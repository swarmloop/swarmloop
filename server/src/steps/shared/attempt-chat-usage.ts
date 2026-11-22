import { Injectable } from '@nestjs/common';
import { NO_USAGE, plusUsage } from '../../agent/since-recorded';
import type { ChatUsage } from '../../history/chat-usage.repository';

interface AttemptUsage {
  attemptId: string;
  chats: Map<string, ChatUsage>;
}

/**
 * What the finished launches of a run's current attempt cost, by chat. A visit is stored only when it ends, so a
 * second launch in the same attempt (a result follow-up, a relaunch) reads the first one's spend here. A new attempt
 * replaces the run's entry, so this holds one attempt per run.
 */
@Injectable()
export class AttemptChatUsage {
  private readonly byRun = new Map<string, AttemptUsage>();

  of(key: string, attemptId: string, chatId: string): ChatUsage {
    const found = this.byRun.get(key);
    return (found?.attemptId === attemptId ? found.chats.get(chatId) : undefined) ?? NO_USAGE;
  }

  add(key: string, attemptId: string, chatId: string, usage: ChatUsage): void {
    const known = this.byRun.get(key);
    const entry = known?.attemptId === attemptId ? known : { attemptId, chats: new Map<string, ChatUsage>() };
    entry.chats.set(chatId, plusUsage(entry.chats.get(chatId) ?? NO_USAGE, usage));
    this.byRun.set(key, entry);
  }
}
