export interface ShellMount {
  hostPath: string;
  containerPath: string;
  volume?: string;
  volumeSubpath?: string;
}

export interface ShellFeature {
  key: string;
  created: boolean;
  status: string;
  currentStep: string;
  runtime: string;
  resumeChatId: string | null;
  mounts: ShellMount[];
  envMasks: { hostFile: string; containerFile: string }[];
  workRoots: string[];
}

export interface ShellMatch {
  key: string;
  status: string;
  currentStep: string;
}

/** The clones of the checkouts root that have an origin, with their server path. */
export interface CloneOriginsView {
  clones: { name: string; path: string; origin: string }[];
}
