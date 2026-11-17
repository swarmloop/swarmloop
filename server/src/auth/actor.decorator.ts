import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ActorRequest } from './auth.guard';
import type { Via } from './auth.service';

/** The login of the person the guard attached (a session's or a personal token's), or null when nobody is logged in. */
export const Actor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    context.switchToHttp().getRequest<ActorRequest>().actor ?? null,
);

/** How the guard knew the person: a `session` or a personal `token`, or null when nobody is logged in. */
export const ActorVia = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Via | null =>
    context.switchToHttp().getRequest<ActorRequest>().via ?? null,
);
