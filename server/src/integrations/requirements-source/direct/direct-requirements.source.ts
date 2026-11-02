import { Injectable } from '@nestjs/common';
import { RequirementsInput, RequirementsSource, RequirementsWrite } from '../requirements-source';
import { buildRecord, recordJson } from '../requirements-record';

export function writeRecord(input: RequirementsInput): RequirementsWrite {
  return {
    body: recordJson(buildRecord(input)),
    calls: 0,
    usd: 0,
    tokensIn: 0,
    tokensOut: 0,
    exchange: null,
    killReason: null,
    samples: [],
    resumed: false,
  };
}

@Injectable()
export class DirectRequirementsService implements RequirementsSource {
  write(input: RequirementsInput): Promise<RequirementsWrite> {
    return Promise.resolve(writeRecord(input));
  }
}
