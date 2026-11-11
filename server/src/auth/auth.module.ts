import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { HistoryModule } from '../history/history.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService, OAUTH_PROVIDERS } from './auth.service';
import { LoginStates } from './login-states';
import { oauthProviders } from './oauth-provider';
import { SessionService } from './session.service';

@Module({
  imports: [HistoryModule],
  controllers: [AuthController],
  providers: [
    SessionService,
    LoginStates,
    AuthService,
    {
      provide: OAUTH_PROVIDERS,
      useFactory: (config: AppConfig, clock: Clock) => oauthProviders(config.env, clock),
      inject: [AppConfig, Clock],
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
