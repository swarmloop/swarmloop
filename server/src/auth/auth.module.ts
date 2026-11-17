import { Module } from '@nestjs/common';
import { APP_GUARD, ModuleRef } from '@nestjs/core';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { Clock } from '../core/clock';
import { HistoryModule } from '../history/history.module';
import { CliLoginController } from './cli-login.controller';
import { CliLogins } from './cli-logins';
import { PeopleController } from './people.controller';
import { TokensController } from './tokens.controller';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService, OAUTH_PROVIDERS } from './auth.service';
import { CheckoutRepos } from './checkout-repos';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { HostAppsService } from './host-apps.service';
import { PeopleService } from './people.service';
import { PersonalCredentials } from './personal-credentials.service';
import { LoginStates } from './login-states';
import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';
import { HOST_APP_STORE } from '../integrations/code-host/login-provider';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { PersonalTokens } from './personal-tokens.service';
import { SecretBox, secretKey } from './secret-box';
import { SessionService } from './session.service';

@Module({
  imports: [HistoryModule],
  controllers: [AuthController, ConnectionsController, TokensController, PeopleController, CliLoginController],
  providers: [
    SessionService,
    CheckoutRepos,
    LoginStates,
    AuthService,
    HostAppsService,
    ConnectionsService,
    ...codeHostAdapters().flatMap((adapter) => (adapter.appFlow ? [adapter.appFlow] : [])),
    { provide: HOST_APP_STORE, useExisting: HostAppsService },
    PersonalCredentials,
    PersonalTokens,
    PeopleService,
    CliLogins,
    {
      provide: SecretBox,
      useFactory: (config: AppConfig) =>
        new SecretBox(secretKey(resolveRepoRoot(config.env.SWARMLOOP_ROOT, __dirname), config.env.SWARMLOOP_SECRET)),
      inject: [AppConfig],
    },
    {
      provide: OAUTH_PROVIDERS,
      useFactory: (config: AppConfig, clock: Clock, apps: HostAppsService, modules: ModuleRef) =>
        CodeHostRegistry.loginProviders(config.env, clock, apps, (flow) => modules.get(flow, { strict: false })),
      inject: [AppConfig, Clock, HostAppsService, ModuleRef],
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, ConnectionsService, HostAppsService, PersonalCredentials, PersonalTokens, PeopleService],
})
export class AuthModule {}
