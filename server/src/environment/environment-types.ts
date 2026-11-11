import type { SandboxMount } from '../core/sandbox-mount';
import type { CheckCommandEntity, RunEntity } from '../history/entities';
import type { SampleDraft } from '../history/visit';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime';
import type { ProjectLaunch } from '../sandbox/sandbox-launch';
import type { EnvironmentConfig } from './environment-config';

/** A project check command that failed: the repository it runs in, the command and the tail of its output. */
export interface FailedCommand {
  repo: string;
  command: string;
  tail: string;
}

/** What an environment is prepared for: a step's mounts, and the runtime of the agent whose CLI the project image gets. */
export interface EnvironmentInput {
  run: RunEntity;
  key: string;
  step: string;
  mounts: SandboxMount[];
  runtime: RuntimeName;
  /** Where the samples of the containers started for this input go: the visit of the step that asked. */
  samples?: SampleDraft[];
}

/** What a run keeps about its environment: the config it started with and how the setup went. */
export interface EnvironmentRecord {
  repo: string;
  ref?: string;
  config: EnvironmentConfig;
  image?: string;
  setup?: { command: string; image: string; exitCode: number; tail: string };
}

export interface PreparedEnvironment {
  launch: ProjectLaunch;
  record: EnvironmentRecord;
  /** The hosts of the checkout's remotes, for the ceiling of the manifest hosts. Absent when the manifest names none. */
  origins?: string[];
}

/** One repository of a checks run: its commands as rows, in order, and what each one answered. */
export interface CheckedRepo {
  mount: SandboxMount;
  prepared: PreparedEnvironment;
  /** Before the first command: the files the commands start from. */
  fingerprint: string;
  rows: CheckCommandEntity[];
  results: ({ exitCode: number; tail: string } | undefined)[];
}

/** One reason the checks did not pass. `repeated` is the reason text when this command failed before on the same files, else empty. */
export interface CheckFailure {
  repo: string;
  body: string;
  repeated: string;
  /** The failed command, absent for the failure that only reports changed project files. */
  failed?: FailedCommand;
}
