export interface SandboxMount {
  hostPath: string;
  containerPath: string;
  /** Path the Docker daemon bind-mounts. Equals hostPath when the server runs on the host. */
  daemonPath?: string;
  /** Named volume shared by the server and the sandbox. Mutually exclusive with daemonPath. */
  volume?: string;
  readonly?: boolean;
}
