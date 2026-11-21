import { api } from './api';
import type { AddRepositoryBody, AddTaskBody, ChangeTaskBody, CreateBacklogBody } from '@contract/backlog-actions';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';
import type { RepositoryMainView } from '@contract/repository-main';

const backlog = (name: string): string => `/backlogs/${encodeURIComponent(name)}`;
const task = (name: string, slug: string): string => `${backlog(name)}/tasks/${encodeURIComponent(slug)}`;
const post = (body?: unknown, headers?: Record<string, string>): RequestInit => ({
  method: 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  ...(headers === undefined ? {} : { headers }),
});

export const listBacklogs = (): Promise<BacklogView[]> => api<BacklogView[]>('/backlogs');
export const getBacklog = (name: string): Promise<BacklogView> => api<BacklogView>(backlog(name));
export const createBacklog = (body: CreateBacklogBody): Promise<BacklogView> =>
  api<BacklogView>('/backlogs', post(body));
export const getBacklogChat = (name: string): Promise<BacklogChatView> =>
  api<BacklogChatView>(`${backlog(name)}/messages`);
/** Posts a message with the ids of its uploaded files; the key makes a repeated send count once. */
export const sendBacklogMessage = (
  name: string,
  text: string,
  attachmentIds: string[],
  idempotencyKey: string,
): Promise<BacklogChatView> =>
  api<BacklogChatView>(
    `${backlog(name)}/messages`,
    post(
      { text, ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}) },
      { 'Idempotency-Key': idempotencyKey },
    ),
  );
export const resumeBacklogTurn = (name: string): Promise<BacklogChatView> =>
  api<BacklogChatView>(`${backlog(name)}/turns/resume`, post());
export const runMilestone = (name: string, number: number): Promise<BacklogView> =>
  api<BacklogView>(`${backlog(name)}/milestones/${number}/run`, post());
export const runBacklog = (name: string): Promise<BacklogView> => api<BacklogView>(`${backlog(name)}/run`, post());
export const pauseBacklog = (name: string): Promise<BacklogView> => api<BacklogView>(`${backlog(name)}/pause`, post());
export const unpauseBacklog = (name: string): Promise<BacklogView> =>
  api<BacklogView>(`${backlog(name)}/pause`, { method: 'DELETE' });
export const addBacklogRepository = (name: string, body: AddRepositoryBody): Promise<BacklogView> =>
  api<BacklogView>(`${backlog(name)}/repositories`, post(body));
export const addBacklogTasks = (name: string, body: AddTaskBody[]): Promise<BacklogView> =>
  api<BacklogView>(`${backlog(name)}/tasks`, post(body));
export const changeBacklogTask = (name: string, slug: string, body: ChangeTaskBody): Promise<BacklogView> =>
  api<BacklogView>(task(name, slug), { method: 'PATCH', body: JSON.stringify(body) });
export const deleteBacklogTask = (name: string, slug: string): Promise<BacklogView> =>
  api<BacklogView>(task(name, slug), { method: 'DELETE' });
export const skipBacklogTask = (name: string, slug: string): Promise<BacklogView> =>
  api<BacklogView>(`${task(name, slug)}/skip`, post());
export const mergeBacklogTask = (name: string, slug: string): Promise<BacklogView> =>
  api<BacklogView>(`${task(name, slug)}/merge`, post());
export const runBacklogTaskNow = (name: string, slug: string): Promise<BacklogView> =>
  api<BacklogView>(`${task(name, slug)}/run`, post());
/** How the default branch of a repository stands now. */
export const getRepositoryMain = (name: string): Promise<RepositoryMainView> =>
  api<RepositoryMainView>(`/repositories/${encodeURIComponent(name)}/main`);
