import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { RunQueriesService } from '../api/run-queries.service';
import { LiveGateway } from './live.gateway';
import { LiveHub } from '../live/live.hub';

describe('LiveGateway', () => {
  it('logs a live update that fails', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const hub = new LiveHub();
      const runs = { list: jest.fn().mockRejectedValue(new Error('boom')), flow: jest.fn() };
      const gateway = new LiveGateway(hub, runs as unknown as RunQueriesService);
      gateway.onModuleInit();
      hub.changed('run-1');
      await wait();
      gateway.onModuleDestroy();
      expect(error).toHaveBeenCalledWith('boom');
    } finally {
      error.mockRestore();
    }
  });

  it('drops a pending update when it is destroyed', async () => {
    const hub = new LiveHub();
    const runs = { list: jest.fn(), flow: jest.fn() };
    const gateway = new LiveGateway(hub, runs as unknown as RunQueriesService);
    gateway.onModuleInit();
    hub.changed('run-1');
    gateway.onModuleDestroy();
    await wait();
    expect(runs.list).not.toHaveBeenCalled();
  });
});

/** The live update waits 40 ms before it publishes. */
function wait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}
