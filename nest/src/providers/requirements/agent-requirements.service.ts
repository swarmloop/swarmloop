import { Injectable } from '@nestjs/common';
import { RequirementsInput, RequirementsSource, RequirementsWrite } from '../contracts';
import { writeRecord } from './direct-requirements.service';

@Injectable()
export class AgentRequirementsService implements RequirementsSource {
  write(input: RequirementsInput): Promise<RequirementsWrite> {
    return Promise.resolve(writeRecord(input));
  }
}
