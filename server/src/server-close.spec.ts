import { EventEmitter } from 'node:events';
import { closeOnStop } from './server-close';

function setup(closeResult: 'resolve' | 'reject' = 'resolve') {
  const entries: string[] = [];
  const codes: number[] = [];
  const emitter = new EventEmitter();
  let exited!: () => void;
  const exit = new Promise<void>((resolve) => {
    exited = resolve;
  });
  let settle!: () => void;
  const pending = new Promise<void>((resolve, reject) => {
    settle = () => (closeResult === 'resolve' ? resolve() : reject(new Error('db busy')));
  });
  const app = {
    close: () => {
      entries.push('close');
      return pending;
    },
  };
  const logger = {
    log: (message: string) => void entries.push(message),
    error: (message: string) => void entries.push(message),
  };
  const target = {
    on: (signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) =>
      emitter.on(signal, () => listener(signal)),
    exit: (code: number) => {
      codes.push(code);
      exited();
    },
  };
  closeOnStop(app, logger, target);
  return { entries, codes, emitter, exit, settle };
}

describe('closeOnStop', () => {
  it('logs the signal, closes once and exits with 143 on SIGTERM', async () => {
    const { entries, codes, emitter, exit, settle } = setup();
    emitter.emit('SIGTERM');
    settle();
    await exit;
    expect(entries).toEqual(['Closing: SIGTERM', 'close', 'Closed']);
    expect(codes).toEqual([143]);
  });

  it('exits with 130 on SIGINT', async () => {
    const { codes, emitter, exit, settle } = setup();
    emitter.emit('SIGINT');
    settle();
    await exit;
    expect(codes).toEqual([130]);
  });

  it('starts nothing more on a second signal during the close', async () => {
    const { entries, codes, emitter, exit, settle } = setup();
    emitter.emit('SIGTERM');
    emitter.emit('SIGTERM');
    emitter.emit('SIGINT');
    settle();
    await exit;
    expect(entries.filter((entry) => entry === 'close')).toHaveLength(1);
    expect(codes).toEqual([143]);
  });

  it('logs a close that throws and exits with 1', async () => {
    const { entries, codes, emitter, exit, settle } = setup('reject');
    emitter.emit('SIGTERM');
    settle();
    await exit;
    expect(entries).toEqual(['Closing: SIGTERM', 'close', 'Close failed: db busy']);
    expect(codes).toEqual([1]);
  });

  it('starts no close on SIGHUP or SIGSEGV', () => {
    const { entries, codes, emitter } = setup();
    emitter.emit('SIGHUP');
    emitter.emit('SIGSEGV');
    expect(entries).toEqual([]);
    expect(codes).toEqual([]);
  });
});
