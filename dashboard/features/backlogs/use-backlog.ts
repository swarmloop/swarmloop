import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';
import { getBacklog, getBacklogChat } from '../../lib/backlog-endpoints';
import { getSession } from '../../lib/endpoints';
import { useBacklogStamp } from '../shell';

interface Loaded {
  view: BacklogView;
  chat: BacklogChatView;
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

/** One backlog with its chat and the signed-in login; the view and chat load again when its stamp moves. */
export function useBacklog(name: string): BacklogState {
  const stamp = useBacklogStamp(name);
  const client = useQueryClient();
  const key = ['backlog', name];
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<Loaded> => {
      const [view, chat] = await Promise.all([getBacklog(name), getBacklogChat(name)]);
      return { view, chat };
    },
  });
  // The signed-in person does not change with the backlog, so it is read once.
  const session = useQuery({ queryKey: ['session'], queryFn: getSession, staleTime: Infinity });
  // A stamp that moves loads the same query again, so requests that are still running merge into one.
  const seen = useRef(stamp);
  useEffect(() => {
    if (seen.current !== stamp) {
      seen.current = stamp;
      void client.invalidateQueries({ queryKey: ['backlog', name] });
    }
  }, [client, name, stamp]);
  const keep = (change: Partial<Loaded>): void => {
    client.setQueryData<Loaded>(key, (current) => (current ? { ...current, ...change } : current));
  };
  return {
    view: query.data?.view ?? null,
    chat: query.data?.chat ?? null,
    login: session.data?.user ?? null,
    error: query.error ? query.error.message : null,
    onView: (view) => keep({ view }),
    onChat: (chat) => keep({ chat }),
  };
}
