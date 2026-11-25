import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { cleanFileName } from '../core/clean-file-name';
import { AttachmentStore } from './attachment-store';
import { attachmentsDir, uploadsDir } from './run-paths';

const DAY = 86_400_000;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'attachment-store-'));
  const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: root }));
  const clock = new FakeClock();
  return { config, clock, store: new AttachmentStore(config, clock) };
}

describe('AttachmentStore', () => {
  it('copies named files into another key with the same names, replaces an earlier copy and keeps the source', async () => {
    const { store, config } = setup();
    const one = await store.stage('a.txt', Buffer.from('one'));
    await store.stage('b.txt', Buffer.from('other'));
    await store.claim('messages', [one.id]);
    await store.copy('messages', 'turn-1', ['a.txt']);
    const target = attachmentsDir(config, 'turn-1');
    expect(store.names('turn-1')).toEqual(['a.txt']);
    expect(statSync(join(target, 'a.txt')).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('one');
    await store.copy('messages', 'turn-1', ['a.txt']);
    expect(store.names('turn-1')).toEqual(['a.txt']);
    expect(store.names('messages')).toEqual(['a.txt']);
  });

  it('stages a file under a clean name and answers its id, name and size', async () => {
    const { store, config } = setup();
    const ref = await store.stage('my notes (1).txt', Buffer.from('hello'));
    expect(ref).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), name: 'my-notes--1-.txt', size: 5 });
    expect(readFileSync(join(uploadsDir(config), ref.id, 'file', ref.name), 'utf8')).toBe('hello');
  });

  it('moves staged files into the run attachments folder, readable by the agent user', async () => {
    const { store, config } = setup();
    const one = await store.stage('a.txt', Buffer.from('one'));
    const two = await store.stage('b.png', Buffer.from('two!'));
    const refs = await store.claim('run-1', [one.id, two.id]);
    expect(refs).toEqual([one, two]);
    const dir = attachmentsDir(config, 'run-1');
    expect(readdirSync(dir).sort()).toEqual(['a.txt', 'b.png']);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one');
    expect(statSync(join(dir, 'a.txt')).mode & 0o777).toBe(0o644);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(uploadsDir(config), one.id))).not.toContain('file');
    expect(store.names('run-1')).toEqual(['a.txt', 'b.png']);
  });

  it('gives a name that is taken a number, and answers the same refs when the same run claims again', async () => {
    const { store } = setup();
    const first = await store.stage('a.txt', Buffer.from('1'));
    const second = await store.stage('a.txt', Buffer.from('2'));
    const refs = await store.claim('run-1', [first.id, second.id]);
    expect(refs.map((ref) => ref.name)).toEqual(['a.txt', 'a-2.txt']);
    expect(await store.claim('run-1', [first.id, second.id])).toEqual(refs);
    expect(store.names('run-1')).toEqual(['a-2.txt', 'a.txt']);
  });

  it('refuses an id that is unknown, or that another run already took, and moves nothing', async () => {
    const { store } = setup();
    const taken = await store.stage('a.txt', Buffer.from('1'));
    const fresh = await store.stage('b.txt', Buffer.from('2'));
    await store.claim('run-1', [taken.id]);
    await expect(store.claim('run-2', [fresh.id, taken.id])).rejects.toBeInstanceOf(BadRequestException);
    await expect(store.claim('run-2', ['../etc'])).rejects.toBeInstanceOf(BadRequestException);
    expect(store.names('run-2')).toEqual([]);
    expect(await store.claim('run-2', [fresh.id])).toHaveLength(1);
  });

  it('has no files for a run that took none', async () => {
    const { store, config } = setup();
    expect(await store.claim('run-1', undefined)).toEqual([]);
    expect(store.names('run-1')).toEqual([]);
    expect(existsSync(attachmentsDir(config, 'run-1'))).toBe(false);
  });

  it('removes staged uploads older than a day and keeps fresh ones', async () => {
    const { store, clock, config } = setup();
    await store.stage('old.txt', Buffer.from('x'));
    clock.advance(DAY - 1000);
    const fresh = await store.stage('new.txt', Buffer.from('y'));
    clock.advance(2000);
    await store.sweepStale();
    expect(readdirSync(uploadsDir(config))).toEqual([fresh.id]);
    clock.advance(DAY);
    await store.sweepStale();
    expect(readdirSync(uploadsDir(config))).toEqual([]);
  });
});

describe('cleanFileName', () => {
  it.each([
    ['plan step', 'plan-step'],
    ['--lead.txt', 'lead.txt'],
    ['..', 'fallback'],
    ['.', 'fallback'],
    ['', 'fallback'],
    ['a'.repeat(100), 'a'.repeat(80)],
  ])('cleans %j to %j', (name, clean) => {
    expect(cleanFileName(name, 'fallback')).toBe(clean);
  });

  it('writes a text file read only beside copied files, one write after another', async () => {
    const { store, config } = setup();
    const one = await store.stage('a.txt', Buffer.from('one'));
    await store.claim('from-1', [one.id]);

    await Promise.all([
      store.copy('from-1', 'turn-1', ['a.txt']),
      store.write('turn-1', 'run-1-error.txt', 'first'),
      store.write('turn-1', 'run-1-error.txt', 'second'),
    ]);

    const dir = attachmentsDir(config, 'turn-1');
    expect(readdirSync(dir).sort()).toEqual(['a.txt', 'run-1-error.txt']);
    expect(readFileSync(join(dir, 'run-1-error.txt'), 'utf8')).toBe('second');
    expect(statSync(join(dir, 'run-1-error.txt')).mode & 0o777).toBe(0o644);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });
});
