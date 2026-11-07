import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { RunQueriesService } from '../api/run-queries.service';
import { LiveGateway } from './live.gateway';
import { LiveHub } from '../live/live.hub';

describe('LiveGateway', () => {
  it('logs a live update that fails', async () => {
    jest.useFakeTimers();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const hub = new LiveHub();
      const runs = { list: jest.fn().mockRejectedValue(new Error('boom')), flow: jest.fn() };
      const gateway = new LiveGateway(hub, runs as unknown as RunQueriesService);
      gateway.onModuleInit();
      hub.changed('run-1');
      await jest.advanceTimersByTimeAsync(60);
      gateway.onModuleDestroy();
      expect(error).toHaveBeenCalledWith('boom');
    } finally {
      jest.useRealTimers();
      error.mockRestore();
    }
  });

  it('drops a pending update when it is destroyed', async () => {
    jest.useFakeTimers();
    try {
      const hub = new LiveHub();
      const runs = { list: jest.fn(), flow: jest.fn() };
      const gateway = new LiveGateway(hub, runs as unknown as RunQueriesService);
      gateway.onModuleInit();
      hub.changed('run-1');
      gateway.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(60);
      expect(runs.list).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('events', () => {
    function setup() {
      const hub = new LiveHub();
      const gateway = new LiveGateway(hub, { list: jest.fn(), flow: jest.fn() } as unknown as RunQueriesService);
      const sent: Array<{ room: string; entry: unknown }> = [];
      gateway.server = {
        to: (room: string) => ({ emit: (_name: string, entry: unknown) => sent.push({ room, entry }) }),
      } as unknown as LiveGateway['server'];
      gateway.onModuleInit();
      return { hub, gateway, sent };
    }

    it('sends one message per 500 ms window with the last seq, then another for a later window', () => {
      jest.useFakeTimers();
      try {
        const { hub, gateway, sent } = setup();
        hub.appended({ key: 'run-1', step: 'implement', seq: 1 });
        jest.advanceTimersByTime(200);
        hub.appended({ key: 'run-1', step: 'implement', seq: 5 });
        expect(sent).toEqual([]);
        jest.advanceTimersByTime(300);
        expect(sent).toEqual([{ room: 'run:run-1', entry: { key: 'run-1', step: 'implement', seq: 5 } }]);
        hub.appended({ key: 'run-1', step: 'implement', seq: 6 });
        jest.advanceTimersByTime(500);
        expect(sent).toHaveLength(2);
        expect(sent[1].entry).toEqual({ key: 'run-1', step: 'implement', seq: 6 });
        gateway.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps two runs apart', () => {
      jest.useFakeTimers();
      try {
        const { hub, gateway, sent } = setup();
        hub.appended({ key: 'run-a', step: 'implement', seq: 3 });
        hub.appended({ key: 'run-b', step: 'commit', seq: 9 });
        jest.advanceTimersByTime(500);
        expect(sent).toEqual([
          { room: 'run:run-a', entry: { key: 'run-a', step: 'implement', seq: 3 } },
          { room: 'run:run-b', entry: { key: 'run-b', step: 'commit', seq: 9 } },
        ]);
        gateway.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
