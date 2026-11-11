import type { MergeRequestState, RequestStateApi } from './code-host';

/** The state of one request; a closed one with no known closer asks the host's closer page, and a failed read leaves it unknown. */
export async function requestState(
  api: RequestStateApi,
  url: string,
  now: string,
  read: (url: string) => Promise<unknown>,
): Promise<MergeRequestState> {
  const state = api.stateOf(await read(url), now);
  const closer = api.closerUrl?.(url);
  if (state.state !== 'closed' || state.by !== null || !closer) {
    return state;
  }
  const page = (await read(closer).catch(() => null)) as { closed_by?: { login?: string } | null } | null;
  return { ...state, by: page?.closed_by?.login ?? null };
}
