import { api, runLog } from './api';
import type {
  AddProjectBody,
  AnswersBody,
  CreateRunBody,
  DrainView,
  FlowView,
  HistoryView,
  ProjectsView,
  ReadinessView,
  ReplayBody,
  RunRef,
  RunsView,
  StepView,
  TicketKeysBody,
  TicketKeysView,
} from '@contract/api';
import type { StepEventPage } from '@contract/step-events';

const run = (key: string): string => `/runs/${encodeURIComponent(key)}`;
const step = (key: string, name: string): string => `${run(key)}/steps/${encodeURIComponent(name)}`;
const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const getReadiness = (): Promise<ReadinessView> => api<ReadinessView>('/readiness');
export const getDrain = (): Promise<DrainView> => api<DrainView>('/drain');
export const listRuns = (): Promise<RunsView> => api<RunsView>('/runs');
export const getFlow = (key: string): Promise<FlowView> => api<FlowView>(run(key));
export const getStep = (key: string, name: string): Promise<StepView> => api<StepView>(step(key, name));
/** The events of one step, or of every step of the run when `name` is null. */
export const getStepEvents = (key: string, name: string | null, after: number): Promise<StepEventPage> =>
  api<StepEventPage>(`${run(key)}/events?${name === null ? '' : `step=${encodeURIComponent(name)}&`}after=${after}`);
export const getHistory = (key: string): Promise<HistoryView> => api<HistoryView>(`${run(key)}/history`);
export const listProjects = (): Promise<{ projects: string[] }> => api<{ projects: string[] }>('/checkouts/projects');
export const getRunLog = (key: string, name: string): Promise<string | null> => runLog(key, name);

export const startDrain = (): Promise<DrainView> => api<DrainView>('/drain', post());
export const createRun = (body: CreateRunBody): Promise<RunRef> => api<RunRef>('/runs', post(body));
export const ticketKeys = (body: TicketKeysBody): Promise<TicketKeysView> =>
  api<TicketKeysView>('/runs/ticket-keys', post(body));
export const setRunProjects = (key: string, name: string): Promise<ProjectsView> =>
  api<ProjectsView>(`${run(key)}/projects`, post({ name } satisfies AddProjectBody));
export const sendAnswers = (key: string, body: AnswersBody): Promise<FlowView> =>
  api<FlowView>(`${run(key)}/answers`, post(body));
export const resumeRun = (key: string): Promise<unknown> => api(`${run(key)}/resume`, post());
export const stopRun = (key: string): Promise<unknown> => api(`${run(key)}/stop`, post());
export const rebaseRun = (key: string): Promise<unknown> => api(`${run(key)}/rebase`, post());
export const startReviewer = (key: string, name: string): Promise<unknown> => api(step(key, name), post());
export const replayStep = (key: string, name: string, body: ReplayBody): Promise<unknown> =>
  api(`${step(key, name)}/replay`, post(body));
export const removeRun = (key: string): Promise<unknown> => api(run(key), { method: 'DELETE' });
