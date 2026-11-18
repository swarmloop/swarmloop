import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Clock } from '../core/clock';
import { SlowRequestRepository } from '../history/server-stall.repository';

const SLOW_MS = 1000;

interface TimedRequest {
  method: string;
  baseUrl: string;
  route?: { path?: unknown };
}

interface TimedResponse {
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

/** Counts the API requests that take longer than a second from arrival to answer, per route. */
@Injectable()
export class RequestTiming implements OnModuleDestroy {
  private readonly logger = new Logger(RequestTiming.name);
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly clock: Clock,
    private readonly slowRequests: SlowRequestRepository,
  ) {}

  middleware(): (req: TimedRequest, res: TimedResponse, next: () => void) => void {
    return (req, res, next) => {
      const arrived = this.clock.now();
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.note(routeOf(req), Math.round(this.clock.now() - arrived));
      };
      res.once('finish', finish);
      res.once('close', finish);
      next();
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.writes;
  }

  private note(route: string, ms: number): void {
    if (ms <= SLOW_MS) return;
    const at = this.clock.iso();
    this.writes = this.writes
      .then(() => this.slowRequests.add(route, ms, at))
      .catch((error: unknown) => {
        this.logger.warn(`A slow request was not counted: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
}

/** The route pattern Express matched, so ids and queries never make a key of their own. */
function routeOf(req: TimedRequest): string {
  const path = req.route?.path;
  return typeof path === 'string' ? `${req.method} ${req.baseUrl}${path}` : `${req.method} unmatched`;
}
