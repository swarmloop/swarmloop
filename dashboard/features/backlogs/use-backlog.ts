import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';
import { getBacklog, getBacklogChat } from '../../lib/backlog-endpoints';
import { getSession } from '../../lib/endpoints';
import { useLiveBridge } from '../shell';

interface Loaded {
  view: BacklogView;
  chat: BacklogChatView;
  login: string | null;
}

interface BacklogState {
  view: BacklogView | null;
  chat: BacklogChatView | null;
  login: string | null;
  error: string | null;
  /** Keeps the view an action answered with, until the next load. */
  onView: (view: BacklogView) => void;
  /** Keeps the chat an action answered with, until the next load. */
  onChat: (chat: BacklogChatView) => void;
}

/** One backlog with its chat and the signed-in login, loaded again when its stamp moves. */
export function useBacklog(name: string): BacklogState {
  const stamp = useLiveBridge((snapshot) => snapshot.backlogStamps[name] ?? 0);
  const client = useQueryClient();
  const key = ['backlog', name, stamp];
  const query = useQuery({
    queryKey: key,
    // The old view of the same backlog stays while a newer one loads, so the page does not blank on each change.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === name ? previous : undefined),
    queryFn: async (): Promise<Loaded> => {
      const [view, chat, session] = await Promise.all([getBacklog(name), getBacklogChat(name), getSession()]);
      return { view, chat, login: session.user };
    },
  });
  const keep = (change: Partial<Loaded>): void => {
    client.setQueryData<Loaded>(key, (current) => (current ? { ...current, ...change } : current));
  };
  return {
    view: query.data?.view ?? null,
    chat: query.data?.chat ?? null,
    login: query.data?.login ?? null,
    error: query.error ? query.error.message : null,
    onView: (view) => keep({ view }),
    onChat: (chat) => keep({ chat }),
  };
}
