import { BadRequestException } from '@nestjs/common';
import type { AppConfig } from '../config/env';
import { assertInsideWork, workRoots } from '../sandbox/allowed-path';

/** A path a person sends must be inside a repository the server is given or inside `worktrees/`. */
export function assertWorkPath(path: string, config: AppConfig): void {
  try {
    assertInsideWork(path, workRoots(config));
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'path is outside the repositories');
  }
}
