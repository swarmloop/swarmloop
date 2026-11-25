import { constants } from 'node:os';
import { Logger } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';

// The server is process 1 of its container, so a signal it no longer handles is dropped.
// Ending its own process after the close is what lets Docker's restart bring it back.
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

interface Closable {
  close(): Promise<void>;
}

interface SignalTarget {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

export function closeOnStop(
  app: Closable,
  logger: Pick<LoggerService, 'log' | 'error'> = new Logger('ServerClose'),
  target: SignalTarget = process,
): void {
  let closing = false;
  const close = async (signal: NodeJS.Signals): Promise<void> => {
    logger.log(`Closing: ${signal}`);
    try {
      await app.close();
    } catch (error) {
      logger.error(`Close failed: ${error instanceof Error ? error.message : String(error)}`);
      target.exit(1);
      return;
    }
    logger.log('Closed');
    target.exit(128 + constants.signals[signal]);
  };
  for (const signal of STOP_SIGNALS) {
    target.on(signal, (received) => {
      if (closing) return;
      closing = true;
      void close(received);
    });
  }
}
