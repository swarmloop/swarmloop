import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRequirementsService } from './agent/agent-requirements.source';
import { DirectRequirementsService } from './direct/direct-requirements.source';
import { byName } from './requirements-source.registry';

export const REQUIREMENTS_SOURCE = Symbol('REQUIREMENTS_SOURCE');

@Module({
  providers: [
    DirectRequirementsService,
    AgentRequirementsService,
    {
      provide: REQUIREMENTS_SOURCE,
      useFactory: (config: ConfigService, agent: AgentRequirementsService, direct: DirectRequirementsService) =>
        byName(config.getOrThrow<string>('REQUIREMENTS_VIA'), { agent, direct }),
      inject: [ConfigService, AgentRequirementsService, DirectRequirementsService],
    },
  ],
  exports: [REQUIREMENTS_SOURCE],
})
export class RequirementsSourceModule {}
