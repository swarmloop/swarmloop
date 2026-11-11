import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ActorRequest } from './auth.guard';

/** The login name or `machine` the guard attached, or null when nobody is logged in. */
export const Actor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    context.switchToHttp().getRequest<ActorRequest>().actor ?? null,
);
