import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { Clock } from '../core/clock';
import { HistoryModule } from '../history/history.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService, OAUTH_PROVIDERS } from './auth.service';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { GithubAppService } from './github-app.service';
import { HostAppsService } from './host-apps.service';
import { LoginStates } from './login-states';
import { oauthProviders } from './oauth-provider';
import { SecretBox, secretKey } from './secret-box';
import { SessionService } from './session.service';

@Module({
  imports: [HistoryModule],
  controllers: [AuthController, ConnectionsController],
  providers: [
    SessionService,
    LoginStates,
    AuthService,
    HostAppsService,
    ConnectionsService,
    GithubAppService,
    {
      provide: SecretBox,
      useFactory: (config: AppConfig) =>
        new SecretBox(secretKey(resolveRepoRoot(config.env.SWARMLOOP_ROOT, __dirname), config.env.SWARMLOOP_SECRET)),
      inject: [AppConfig],
    },
    {
      provide: OAUTH_PROVIDERS,
      useFactory: (config: AppConfig, clock: Clock, apps: HostAppsService) => oauthProviders(config.env, clock, apps),
      inject: [AppConfig, Clock, HostAppsService],
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, ConnectionsService, HostAppsService],
})
export class AuthModule {}
