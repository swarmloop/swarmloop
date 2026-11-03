import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/env';
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
      useFactory: (config: AppConfig, agent: AgentRequirementsService, direct: DirectRequirementsService) =>
        byName(config.env.REQUIREMENTS_VIA, { agent, direct }),
      inject: [AppConfig, AgentRequirementsService, DirectRequirementsService],
    },
  ],
  exports: [REQUIREMENTS_SOURCE],
})
export class RequirementsSourceModule {}
