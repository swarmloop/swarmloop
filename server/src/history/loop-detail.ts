/** The loop counter of the history lines the merge watch writes. They are not returns of a step. */
export const MERGE_WATCH_COUNTER = 'merge-watch';

/** The loop counter of the history lines a CI that does not start writes: the nudge of the host. They are not returns of a step. */
export const CI_WAIT_COUNTER = 'ci-wait';

/** What `EventRepository.recordLoop` stores in `detail`. */
interface LoopDetail {
  /** The failed commands of a checks return. */
  commands?: string[];
  /** A pipeline return: its failed jobs, and whether the checks of the same content had passed. */
  jobs?: string[];
  ciOnly?: boolean;
}

/** The detail of a loop row; older rows and unreadable text give an empty one. */
export function readLoopDetail(detail: string | null | undefined): LoopDetail {
  try {
    return (JSON.parse(detail ?? '{}') as LoopDetail | null) ?? {};
  } catch {
    return {};
  }
}
