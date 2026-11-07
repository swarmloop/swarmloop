import type { Type } from '@nestjs/common';
import { AppConfig } from '../../config/env';
import { worktreePath } from '../../git/repo-names';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { root } from '../../history/run-paths';
import { stampGate, worktreesFingerprint } from './gate';

/** Stamps the stored document `kind` for the current generation and the worktrees of `repos`, as a step that wrote it does. */
export async function stampStored(
  app: { get<T>(token: Type<T>): T },
  run: RunEntity,
  kind: string,
  repos: string[],
): Promise<void> {
  const paths = repos.map((name) => worktreePath(root(app.get(AppConfig)), run.key, name));
  await stampGate(app.get(DocumentRepository), run, kind, await worktreesFingerprint(paths));
}

/** Stores a document the way a step that passed on the worktrees of `repos` does: with its stamp. */
export async function putStamped(
  app: { get<T>(token: Type<T>): T },
  run: RunEntity,
  kind: string,
  body: string,
  repos: string[],
): Promise<void> {
  await app.get(DocumentRepository).putDocument(run, kind, body);
  await stampStored(app, run, kind, repos);
}
