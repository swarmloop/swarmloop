import type { MigrationInterface, QueryRunner } from 'typeorm';

interface Totals {
  usd: number;
  tokensIn: number;
  tokensOut: number;
}

interface StoredVisit extends Totals {
  id: number;
  runId: number;
  chatId: string;
  resumed: number;
}

/** A total at least the chat's running total is that and this visit; a smaller one is this visit alone. */
function since(total: number, running: number): number {
  return total >= running ? total - running : total;
}

function advance(total: number, running: number): number {
  return total >= running ? total : running + total;
}

/**
 * A resumed session reported the cost and tokens of the whole session, so each stored visit counted the earlier
 * ones again. This writes each such visit as its own part. The rule is written here and not shared with the app,
 * because a migration must not change when the app code later does.
 */
export class VisitCostDeltas1797000000001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const visits = (await queryRunner.query(
      `SELECT s.id AS id, s.run_id AS runId, s.usd AS usd, s.tokens_in AS tokensIn, s.tokens_out AS tokensOut,
              e.chat_id AS chatId, e.resumed AS resumed
       FROM step_stats s
       JOIN agent_exchanges e ON e.id = (
         SELECT MAX(id) FROM agent_exchanges WHERE step_stat_id = s.id AND chat_id IS NOT NULL
       )
       ORDER BY s.id`,
    )) as StoredVisit[];
    const running = new Map<string, Totals>();
    const changedRuns = new Set<number>();
    for (const visit of visits) {
      const before = (visit.resumed ? running.get(visit.chatId) : undefined) ?? { usd: 0, tokensIn: 0, tokensOut: 0 };
      running.set(visit.chatId, {
        usd: advance(visit.usd, before.usd),
        tokensIn: advance(visit.tokensIn, before.tokensIn),
        tokensOut: advance(visit.tokensOut, before.tokensOut),
      });
      const own = {
        usd: since(visit.usd, before.usd),
        tokensIn: since(visit.tokensIn, before.tokensIn),
        tokensOut: since(visit.tokensOut, before.tokensOut),
      };
      if (own.usd === visit.usd && own.tokensIn === visit.tokensIn && own.tokensOut === visit.tokensOut) {
        continue;
      }
      await queryRunner.query(`UPDATE step_stats SET usd = ?, tokens_in = ?, tokens_out = ? WHERE id = ?`, [
        own.usd,
        own.tokensIn,
        own.tokensOut,
        visit.id,
      ]);
      changedRuns.add(visit.runId);
    }
    for (const runId of changedRuns) {
      await queryRunner.query(
        `UPDATE runs SET spent_usd = (SELECT COALESCE(SUM(usd), 0) FROM step_stats WHERE run_id = ?) WHERE id = ?`,
        [runId, runId],
      );
    }
  }

  async down(): Promise<void> {
    // The session totals the old rows held cannot be told from the deltas now, so there is nothing to restore.
  }
}
