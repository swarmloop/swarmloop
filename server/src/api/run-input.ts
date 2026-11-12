import { BadRequestException } from '@nestjs/common';
import { CHECKOUT_NAME } from '../config/checkout-path';
import { normalizePhases } from '../core/pipeline-result';
import type { PhaseName } from '../contract/steps';

/** The phases a request names, or the defaults. A bad name is a 400. */
export function phaseNames(input?: string[]): PhaseName[] {
  try {
    return normalizePhases(input);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'phases are invalid');
  }
}

/** The distinct, sorted project names a request names. A name that is not a checkout is a 400. */
export function projectNames(input?: string[]): string[] {
  const names = [...new Set((input ?? []).map((name) => name.trim()).filter((name) => name.length > 0))].sort();
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('run-') || !CHECKOUT_NAME.test(name)) {
      throw new BadRequestException(`${name} is not a project`);
    }
  }
  return names;
}
