import {
  BadGatewayException,
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { AppConfig } from '../config/env';
import { decide, parseAllow } from './allow-list';
import { AuthService } from './auth.service';
import { LoginStates } from './login-states';
import type { OAuthProvider } from './oauth-provider';
import { Public } from './public.decorator';
import { cookieValue, SESSION_COOKIE, SESSION_DAYS, SessionService, sessionIdOf } from './session.service';

const STATE_COOKIE = 'swarmloop_state';

interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
  redirect(url: string): void;
}

/** Login with GitHub or GitLab. The session cookie is the only thing that outlives the login call. */
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly states: LoginStates,
    private readonly sessions: SessionService,
  ) {}

  @Get('providers')
  providers(): { providers: string[] } {
    return { providers: this.auth.configured().map((provider) => provider.name) };
  }

  @Get('me')
  async me(@Req() request: { headers: { cookie?: string } }): Promise<{ user: string | null; provider?: string }> {
    const session = await this.sessions.find(sessionIdOf(request.headers.cookie));
    return session ? { user: session.user, provider: session.provider } : { user: null };
  }

  @Get(':provider/login')
  login(@Param('provider') name: string, @Res() response: CookieResponse): void {
    const provider = this.provider(name);
    const { state, verifier } = this.states.start(provider.name);
    response.cookie(STATE_COOKIE, state, { ...this.cookieOptions(), path: '/auth', maxAge: 10 * 60 * 1000 });
    response.redirect(provider.authorizeUrl(this.redirectUri(provider), state, verifier));
  }

  @Get(':provider/callback')
  async callback(
    @Param('provider') name: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: { headers: { cookie?: string } },
    @Res() response: CookieResponse,
  ): Promise<void> {
    const provider = this.provider(name);
    const bound = cookieValue(request.headers.cookie, STATE_COOKIE);
    const pending = state && bound === state ? this.states.take(state) : null;
    response.clearCookie(STATE_COOKIE, { ...this.cookieOptions(), path: '/auth' });
    if (!pending || pending.provider !== provider.name || !code) {
      throw new BadRequestException('the login did not start here or has expired: try again');
    }
    const identity = await provider
      .identify(code, this.redirectUri(provider), pending.verifier)
      .catch((error: unknown) => {
        throw new BadGatewayException(error instanceof Error ? error.message : `${provider.name} login failed`);
      });
    const verdict = await decide(
      parseAllow(this.config.env.SWARMLOOP_ALLOW),
      { provider: provider.name, ...identity },
      () => provider.tokenOwner(),
    );
    if (!verdict.allowed) {
      throw new ForbiddenException(`${provider.name}:${identity.user} may not log in: ${verdict.reason}`);
    }
    const session = await this.sessions.create(identity.user, provider.name);
    response.cookie(SESSION_COOKIE, session.id, {
      ...this.cookieOptions(),
      path: '/',
      maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    });
    response.redirect('/');
  }

  @Post('logout')
  async logout(
    @Req() request: { headers: { cookie?: string } },
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<{ ok: true }> {
    const id = sessionIdOf(request.headers.cookie);
    if (id) {
      await this.sessions.delete(id);
    }
    response.clearCookie(SESSION_COOKIE, { ...this.cookieOptions(), path: '/' });
    return { ok: true };
  }

  private provider(name: string): OAuthProvider {
    const provider = this.auth.configured().find((candidate) => candidate.name === name);
    if (!provider) {
      throw new NotFoundException(`${name} login is not configured`);
    }
    return provider;
  }

  private redirectUri(provider: OAuthProvider): string {
    return `${this.config.env.SWARMLOOP_PUBLIC_URL.replace(/\/$/, '')}/auth/${provider.name}/callback`;
  }

  private cookieOptions(): Record<string, unknown> {
    return { httpOnly: true, sameSite: 'lax', secure: this.config.env.SWARMLOOP_PUBLIC_URL.startsWith('https:') };
  }
}
