import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** What a chat has cost so far. Prompt-side tokens include cache, as `step_stats` stores them. */
export interface ChatUsage {
  usd: number;
  tokensIn: number;
  tokensOut: number;
}

/** The recorded spend of a chat: the sum of the stored visits that used it. */
@Injectable()
export class ChatUsageRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** A visit with several exchanges on the chat counts once. */
  async totalsOf(chatId: string): Promise<ChatUsage> {
    const rows: { usd: number | null; tokensIn: number | null; tokensOut: number | null }[] =
      await this.dataSource.query(
        `SELECT SUM(usd) AS usd, SUM(tokens_in) AS tokensIn, SUM(tokens_out) AS tokensOut FROM step_stats
         WHERE id IN (SELECT step_stat_id FROM agent_exchanges WHERE chat_id = ?)`,
        [chatId],
      );
    const row = rows[0];
    return { usd: Number(row?.usd) || 0, tokensIn: Number(row?.tokensIn) || 0, tokensOut: Number(row?.tokensOut) || 0 };
  }
}
