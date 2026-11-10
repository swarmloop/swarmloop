import { InitialSchema1793664000000 } from './1793664000000-initial-schema';
import { RetireVerifyStep1793800000000 } from './1793800000000-retire-verify-step';
import { RunAttempts1793900000000 } from './1793900000000-run-attempts';
import { StepEvents1794000000000 } from './1794000000000-step-events';
import { Commands1794100000000 } from './1794100000000-commands';
import { RunGeneration1794200000000 } from './1794200000000-run-generation';
import { RunWorkspace1794300000000 } from './1794300000000-run-workspace';
import { ReleaseMeta1794400000000 } from './1794400000000-release-meta';
import { DropReleaseMeta1794500000000 } from './1794500000000-drop-release-meta';
import { StepRuntime1794600000000 } from './1794600000000-step-runtime';

// To add a migration: run `npm run migration:generate -- src/history/migrations/<name>`, export the generated class
// from its own file, and append it here. Migrations run in list order at startup.
export const migrations = [
  InitialSchema1793664000000,
  RetireVerifyStep1793800000000,
  RunAttempts1793900000000,
  StepEvents1794000000000,
  Commands1794100000000,
  RunGeneration1794200000000,
  RunWorkspace1794300000000,
  ReleaseMeta1794400000000,
  DropReleaseMeta1794500000000,
  StepRuntime1794600000000,
];
