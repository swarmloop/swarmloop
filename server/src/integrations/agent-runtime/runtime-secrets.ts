import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { runtimeKeysOf } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { registerSecretSource } from '../../core/secret-sources';
import { RUNTIME_NAMES, runtimeFor } from './agent-runtime.registry';

/** Lists the keys of the environment that the runtimes launch with. */
@Injectable()
export class RuntimeSecrets implements OnModuleInit, OnModuleDestroy {
  private unregister: (() => void) | undefined;

  constructor(private readonly config: AppConfig) {}

  onModuleInit(): void {
    this.unregister = registerSecretSource(() =>
      RUNTIME_NAMES.flatMap((name) => runtimeFor(name).secrets(runtimeKeysOf(this.config.env))),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }
}
