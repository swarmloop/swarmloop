import { Injectable } from '@nestjs/common';
import { RequirementsInput, RequirementsSource, RequirementsWrite } from '../requirements-source';
import { writeRecord } from '../direct/direct-requirements.source';

@Injectable()
export class AgentRequirementsService implements RequirementsSource {
  write(input: RequirementsInput): Promise<RequirementsWrite> {
    return Promise.resolve(writeRecord(input));
  }
}
