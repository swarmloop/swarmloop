import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, type Credentials, type Via } from './auth.service';
import { PUBLIC_KEY } from './public.decorator';

export interface ActorRequest {
  headers: Credentials;
  actor?: string | null;
  via?: Via | null;
}

/** Every route needs a session or a personal token, except those marked `@Public()`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest<ActorRequest>();
    const { allowed, actor, via } = await this.auth.check(request.headers);
    if (!allowed) {
      throw new UnauthorizedException('log in first');
    }
    request.actor = actor;
    request.via = via;
    return true;
  }
}
