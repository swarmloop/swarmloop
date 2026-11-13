import { AgentEffort1795900000000 } from './1795900000000-agent-effort';
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
import { RunParent1794600000000 } from './1794600000000-run-parent';
import { RunSplit1794700000000 } from './1794700000000-run-split';
import { RuntimeCooldown1794700000000 } from './1794700000000-runtime-cooldown';
import { Sessions1794800000000 } from './1794800000000-sessions';
import { RunIndexes1794800000000 } from './1794800000000-run-indexes';
import { EmptyLogBodies1794900000000 } from './1794900000000-empty-log-bodies';
import { ChecksStep1795000000000 } from './1795000000000-checks-step';
import { PreparedMs1795100000000 } from './1795100000000-prepared-ms';
import { Connections1795200000000 } from './1795200000000-connections';
import { MergeOutcome1795200000000 } from './1795200000000-merge-outcome';
import { ShellEdits1795200000000 } from './1795200000000-shell-edits';
import { CheckCommandName1795300000000 } from './1795300000000-check-command-name';
import { ReturnDetail1795300000000 } from './1795300000000-return-detail';
import { UserSettings1795400000000 } from './1795400000000-user-settings';
import { SubtaskFingerprint1795500000000 } from './1795500000000-subtask-fingerprint';
import { DropPersonalSplit1795600000000 } from './1795600000000-drop-personal-split';

// To add a migration: run `npm run migration:generate -- src/history/migrations/<name>`, export the generated class
// from its own file, and append it here. Migrations run in list order at startup.
import { FlakyTests1795700000000 } from './1795700000000-flaky-tests';
import { CheckCommandsAttemptIndex1795800000000 } from './1795800000000-check-commands-attempt-index';

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
  RunParent1794600000000,
  RunSplit1794700000000,
  RuntimeCooldown1794700000000,
  Sessions1794800000000,
  RunIndexes1794800000000,
  EmptyLogBodies1794900000000,
  ChecksStep1795000000000,
  PreparedMs1795100000000,
  Connections1795200000000,
  MergeOutcome1795200000000,
  ShellEdits1795200000000,
  CheckCommandName1795300000000,
  ReturnDetail1795300000000,
  UserSettings1795400000000,
  SubtaskFingerprint1795500000000,
  DropPersonalSplit1795600000000,
  FlakyTests1795700000000,
  CheckCommandsAttemptIndex1795800000000,
  AgentEffort1795900000000,
];
