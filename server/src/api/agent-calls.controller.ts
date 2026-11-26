import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type {
  CallTimelineScope,
  CallTimelineView,
  CallTotalsBy,
  CallTotalsView,
  KeepWarmView,
} from '../contract/agent-calls';
import { AgentCallQueries } from '../history/agent-call-queries';

const TOTALS_BY: readonly CallTotalsBy[] = ['task', 'epic', 'step', 'level', 'backlog'];
const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 7 * 24 * 60;

/** A query value is a string given once: a repeated key arrives as an array. */
function givenOnce(values: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && typeof value !== 'string') {
      throw new BadRequestException(`${name} is given once`);
    }
  }
}

@Controller('agent-calls')
export class AgentCallsController {
  constructor(private readonly queries: AgentCallQueries) {}

  /** `by`: task, epic, step, level or backlog. `step` keeps only that step's rows. */
  @Get('totals')
  async totals(@Query('by') by?: string, @Query('step') step?: string): Promise<CallTotalsView> {
    givenOnce({ by, step });
    const grouping = TOTALS_BY.find((name) => name === by);
    if (!grouping) {
      throw new BadRequestException(`by must be one of ${TOTALS_BY.join(', ')}`);
    }
    return { by: grouping, lines: await this.queries.totals(grouping, step || undefined) };
  }

  /** Exactly one of `task`, `step` or `epic`. */
  @Get('timeline')
  async timeline(
    @Query('task') task?: string,
    @Query('step') step?: string,
    @Query('epic') epic?: string,
  ): Promise<CallTimelineView> {
    givenOnce({ task, step, epic });
    const named = (
      [
        ['task', task],
        ['step', step],
        ['epic', epic],
      ] as [CallTimelineScope, string | undefined][]
    ).filter(([, key]) => key);
    if (named.length !== 1) {
      throw new BadRequestException('give exactly one of task, step or epic');
    }
    const [scope, key] = named[0] as [CallTimelineScope, string];
    return { scope, key, entries: await this.queries.timeline(scope, key) };
  }

  /** `ttl`: the cache lifetime in minutes (default 60). `task`, `epic` and `step` narrow the figures. */
  @Get('keep-warm')
  keepWarm(
    @Query('ttl') ttl?: string,
    @Query('task') task?: string,
    @Query('epic') epic?: string,
    @Query('step') step?: string,
  ): Promise<KeepWarmView> {
    givenOnce({ ttl, task, epic, step });
    const minutes = ttl === undefined || ttl === '' ? DEFAULT_TTL_MINUTES : Number(ttl);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TTL_MINUTES) {
      throw new BadRequestException(`ttl must be a whole number from 1 to ${MAX_TTL_MINUTES}`);
    }
    return this.queries.keepWarm(minutes, {
      task: task || undefined,
      epic: epic || undefined,
      step: step || undefined,
    });
  }
}
