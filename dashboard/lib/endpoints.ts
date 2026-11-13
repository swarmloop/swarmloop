import { api, runLog, type LogPaging } from './api';
import type {
  AddProjectBody,
  AnswersBody,
  CreateRepositoryBody,
  ConnectionsView,
  CreateRunBody,
  FlowView,
  HistoryView,
  MeView,
  ProjectsView,
  ProjectListView,
  RemoteEntry,
  RemoteListView,
  ReplayBody,
  SkipTaskBody,
  RunRef,
  RunsView,
  SettingsBody,
  StatsView,
  StepView,
  TicketKeysBody,
  TicketKeysView,
} from '@contract/api';
import type { ReadinessView } from '@contract/readiness';
import type { SettingsView } from '@contract/settings';
import type { StepEventPage } from '@contract/step-events';

const run = (key: string): string => `/runs/${encodeURIComponent(key)}`;
const step = (key: string, name: string): string => `${run(key)}/steps/${encodeURIComponent(name)}`;
const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const getProviders = (): Promise<{ providers: string[] }> => api('/auth/providers');
/** The signed-in person, with the host and the avatar of the host account. */
export const getSession = (): Promise<MeView> => api<MeView>('/auth/me');
/** The manifest of the GitHub App and the GitHub page it is posted to, for the account or an organization. */
export const getManifest = (org: string): Promise<{ action: string; manifest: Record<string, unknown> }> =>
  api(`/auth/github/manifest${org ? `?org=${encodeURIComponent(org)}` : ''}`);
/** The owner of the repositories this server works on, and the other owners, for the first-run form. */
export const getOwner = (): Promise<{ owner: string; others: string[] }> => api('/auth/github/owner');
/** The page where the app is installed on the repositories; asking sets the state cookie of the login. */
export const getInstallUrl = (): Promise<{ url: string }> => api('/auth/github/install');
export const saveGitlabApplication = (clientId: string, clientSecret: string): Promise<{ ok: true }> =>
  api('/auth/gitlab/application', post({ clientId, clientSecret }));
export const getConnections = (): Promise<ConnectionsView> => api<ConnectionsView>('/connections');
/** The page where the person adds repositories to the GitHub installation. */
export const installMore = (host: string): Promise<{ url: string }> => api(`/connections/${host}/install`, post());
export const reconnectUrl = (host: string): string => `/auth/${host}/login`;
export const disconnect = (host: string): Promise<{ ok: true }> => api(`/connections/${host}`, { method: 'DELETE' });
/** The manifest form for a new GitHub App. The old app and its connections stay until GitHub returns the new one. */
export const replaceApp = (): Promise<{ action: string; manifest: Record<string, unknown> }> =>
  api('/connections/github/app', post());
/** The person's own settings with the server defaults, the connected runtimes and the env-only settings. */
export const getSettings = (): Promise<SettingsView> => api<SettingsView>('/settings');
export const saveSettings = (body: SettingsBody): Promise<SettingsView> =>
  api<SettingsView>('/settings', { method: 'PUT', body: JSON.stringify(body) });
export const logout = (): Promise<unknown> => api('/auth/logout', post());
export const getReadiness = (): Promise<ReadinessView> => api<ReadinessView>('/readiness');
export const listRuns = (): Promise<RunsView> => api<RunsView>('/runs');
/** The statistics of the runs started in the last `days` local days (0: all of them). `tz` is `getTimezoneOffset()`. */
export const getStats = (days: number, tz: number): Promise<StatsView> =>
  api<StatsView>(`/stats?days=${days}&tz=${tz}`);
export const getFlow = (key: string): Promise<FlowView> => api<FlowView>(run(key));
export const getStep = (key: string, name: string): Promise<StepView> => api<StepView>(step(key, name));
/** The events of one step, or of every step of the run when `name` is null. */
export const getStepEvents = (key: string, name: string | null, after: number): Promise<StepEventPage> =>
  api<StepEventPage>(`${run(key)}/events?${name === null ? '' : `step=${encodeURIComponent(name)}&`}after=${after}`);
export const getHistory = (key: string): Promise<HistoryView> => api<HistoryView>(`${run(key)}/history`);
export const listProjects = (): Promise<ProjectListView> => api<ProjectListView>('/checkouts/projects');
/** The repositories of the connected code hosts that the server's tokens can push to. */
export const listRemote = (): Promise<RemoteListView> => api<RemoteListView>('/checkouts/remote');
export const getRunLog = (key: string, name: string, attempt?: string, paging?: LogPaging): Promise<string | null> =>
  runLog(key, name, attempt, paging);

export const createRun = (body: CreateRunBody): Promise<RunRef> => api<RunRef>('/runs', post(body));
export const createRepository = (body: CreateRepositoryBody): Promise<RemoteEntry> =>
  api<RemoteEntry>('/checkouts/repositories', post(body));
export const ticketKeys = (body: TicketKeysBody): Promise<TicketKeysView> =>
  api<TicketKeysView>('/runs/ticket-keys', post(body));
export const setRunProjects = (key: string, name: string): Promise<ProjectsView> =>
  api<ProjectsView>(`${run(key)}/projects`, post({ name } satisfies AddProjectBody));
export const sendAnswers = (key: string, body: AnswersBody): Promise<FlowView> =>
  api<FlowView>(`${run(key)}/answers`, post(body));
export const resumeRun = (key: string): Promise<unknown> => api(`${run(key)}/resume`, post());
export const stopRun = (key: string): Promise<unknown> => api(`${run(key)}/stop`, post());
export const skipTask = (key: string, taskId: string): Promise<unknown> =>
  api(`${run(key)}/skip-task`, post({ taskId } satisfies SkipTaskBody));
export const rebaseRun = (key: string): Promise<unknown> => api(`${run(key)}/rebase`, post());
export const startReviewer = (key: string, name: string): Promise<unknown> => api(step(key, name), post());
export const replayStep = (key: string, name: string, body: ReplayBody): Promise<unknown> =>
  api(`${step(key, name)}/replay`, post(body));
export const removeRun = (key: string): Promise<unknown> => api(run(key), { method: 'DELETE' });
