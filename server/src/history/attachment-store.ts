import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { readdirSync } from 'fs';
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { basename, join, resolve, sep } from 'path';
import { AppConfig } from '../config/env';
import type { AttachmentRef } from '../contract/attachments';
import { Clock } from '../core/clock';
import { cleanFileName } from '../core/clean-file-name';
import { attachmentsDir, uploadsDir } from './run-paths';

const DAY_MS = 86_400_000;
const UPLOAD_ID = /^[0-9a-f]{32}$/;

/** What stays of one staged upload: when it came, and where it went once a run took it. */
interface StagedMeta {
  at: number;
  ref: AttachmentRef;
  key?: string;
}

/** The staged folder of an upload id: the id must be one this store made, and the folder must lie inside the uploads folder. */
function stagedDirOf(uploads: string, id: unknown): string {
  const dir = typeof id === 'string' && UPLOAD_ID.test(id) ? resolve(uploads, id) : null;
  if (!dir || !dir.startsWith(`${resolve(uploads)}${sep}`)) {
    throw new BadRequestException(`the file ${String(id)} is not known. Send it again.`);
  }
  return dir;
}

/** The files of a run: staged when uploaded, moved into the run's read-only attachments folder when it takes them. */
@Injectable()
export class AttachmentStore {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /** Keeps the bytes under a new id. The name is cleaned the way a brief's name is. */
  async stage(name: string, bytes: Buffer): Promise<AttachmentRef> {
    if (typeof name !== 'string') {
      throw new BadRequestException('name is missing');
    }
    const id = randomUUID().replaceAll('-', '');
    // The bytes come from a request body: only a real Buffer is kept, anything else is an empty file.
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0);
    const ref = { id, name: basename(cleanFileName(name, 'file')), size: data.byteLength };
    const dir = stagedDirOf(uploadsDir(this.config), id);
    await mkdir(join(dir, 'file'), { recursive: true, mode: 0o755 });
    await chmod(join(dir, 'file'), 0o755);
    await chmod(dir, 0o755);
    await this.write(join(dir, 'file', ref.name), data);
    await this.writeMeta(id, { at: this.clock.now(), ref });
    return ref;
  }

  /**
   * Moves the staged files into the run's attachments folder. A file the same run already took answers again with
   * the same ref, so a replayed command is safe; a file that is unknown, or taken by another run, is refused.
   */
  claim(key: string, ids: readonly string[] | undefined): Promise<AttachmentRef[]> {
    const wanted: string[] = [
      ...new Set<string>(
        Array.isArray(ids) ? (ids as readonly unknown[]).filter((id): id is string => typeof id === 'string') : [],
      ),
    ];
    if (wanted.length === 0) {
      return Promise.resolve([]);
    }
    const run = (this.tails.get(key) ?? Promise.resolve()).then(() => this.claimAll(key, wanted));
    this.tails.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  /** The names of the files a run has, in order. It reads without waiting: every agent launch asks, and a wait would move the launches of concurrent steps against each other. */
  names(key: string): string[] {
    try {
      return readdirSync(attachmentsDir(this.config, key)).sort();
    } catch {
      return [];
    }
  }

  /** Removes the staged uploads that are more than a day old. */
  async sweepStale(): Promise<void> {
    let ids: string[];
    try {
      ids = await readdir(uploadsDir(this.config));
    } catch {
      return;
    }
    for (const id of ids) {
      const meta = UPLOAD_ID.test(id) ? await this.readMeta(id) : null;
      const age = meta ? this.clock.now() - meta.at : Infinity;
      if (age > DAY_MS) {
        await rm(stagedDirOf(uploadsDir(this.config), id), { recursive: true, force: true });
      }
    }
  }

  private async claimAll(key: string, ids: string[]): Promise<AttachmentRef[]> {
    const metas = await Promise.all(ids.map((id) => this.known(id, key)));
    const refs: AttachmentRef[] = [];
    for (const meta of metas) {
      refs.push(meta.key ? meta.ref : await this.move(key, meta));
    }
    return refs;
  }

  private async known(id: string, key: string): Promise<StagedMeta> {
    const meta = UPLOAD_ID.test(id) ? await this.readMeta(id) : null;
    if (!meta || (meta.key !== undefined && meta.key !== key)) {
      throw new BadRequestException(`the file ${id} is not known. Send it again.`);
    }
    return meta;
  }

  private async move(key: string, meta: StagedMeta): Promise<AttachmentRef> {
    const target = attachmentsDir(this.config, key);
    await mkdir(target, { recursive: true, mode: 0o755 });
    await chmod(target, 0o755);
    const name = await this.freeName(target, basename(meta.ref.name));
    const staged = stagedDirOf(uploadsDir(this.config), meta.ref.id);
    await copyFile(join(staged, 'file', basename(meta.ref.name)), join(target, name));
    await chmod(join(target, name), 0o644);
    await rm(join(staged, 'file'), { recursive: true, force: true });
    const ref = { ...meta.ref, name };
    await this.writeMeta(ref.id, { at: meta.at, ref, key });
    return ref;
  }

  /** The name, or the name with a number before its extension when the folder has it already. */
  private async freeName(dir: string, name: string): Promise<string> {
    const taken = new Set(await readdir(dir));
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = name;
    for (let n = 2; taken.has(candidate); n += 1) {
      candidate = `${stem}-${n}${extension}`;
    }
    return candidate;
  }

  private async write(path: string, bytes: Buffer): Promise<void> {
    await writeFile(path, bytes);
    await chmod(path, 0o644);
  }

  private async readMeta(id: string): Promise<StagedMeta | null> {
    try {
      const dir = stagedDirOf(uploadsDir(this.config), id);
      await stat(dir);
      return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as StagedMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(id: string, meta: StagedMeta): Promise<void> {
    return writeFile(join(stagedDirOf(uploadsDir(this.config), id), 'meta.json'), JSON.stringify(meta));
  }
}
