import { api, runLog, type LogPaging } from './api';
import type {
  AddProjectBody,
  CreateRepositoryBody,
  ConnectionsView,
  CreateRunBody,
  FlowView,
  HistoryView,
  MeView,
  ProvidersView,
  ProjectsView,
  ProjectListView,
  RemoteEntry,
  RemoteListView,
  ReplayBody,
  SkipTaskBody,
  RunRef,
  SettingsBody,
  StatsView,
  StepView,
  TicketKeysBody,
  TicketKeysView,
} from '@contract/api';
import type { UploadView } from '@contract/attachments';
import type { ConnectionCard, IntegrationCardsView, SignInView } from '@contract/connections';
import type { CreateTokenBody, CreatedTokenView, TokensView, UseTokenBody } from '@contract/people';
import type { DoneLatelyItem } from '@contract/overview-done';
import type { ReadinessView } from '@contract/readiness';
import type { Part, RunsPage } from '@contract/run-list';
import type { SettingsView } from '@contract/settings';
import type { StepEventPage } from '@contract/step-events';

const run = (key: string): string => `/runs/${encodeURIComponent(key)}`;
const step = (key: string, name: string): string => `${run(key)}/steps/${encodeURIComponent(name)}`;
const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const getProviders = (): Promise<ProvidersView> => api('/auth/providers');
/** Signs in with a personal access token made on the host. Answers where the browser goes next. */
export const signInWithToken = (provider: string, token: string, next: string | null): Promise<{ url: string }> =>
  api(`/auth/${provider}/token`, post({ token, next: next ?? undefined }));
/** The signed-in person, with the host and the avatar of the host account. */
export const getSession = (): Promise<MeView> => api<MeView>('/auth/me');
/** The manifest of the GitHub App and the GitHub page it is posted to, for the account or an organization. */
export const getManifest = (org: string): Promise<{ action: string; manifest: Record<string, unknown> }> =>
  api(`/auth/github/manifest${org ? `?org=${encodeURIComponent(org)}` : ''}`);
/** The owner of the repositories this server works on, and the other owners, for the first-run form. */
export const getOwner = (): Promise<{ owner: string; others: string[] }> => api('/auth/github/owner');
/** The page where the app is installed on the repositories; asking sets the state cookie of the login. */
export const getInstallUrl = (): Promise<{ url: string }> => api('/auth/github/install');
export const saveApplication = (host: string, clientId: string, clientSecret: string): Promise<{ ok: true }> =>
  api(`/auth/${host}/application`, post({ clientId, clientSecret }));
export const getConnections = (): Promise<ConnectionsView> => api<ConnectionsView>('/connections');
/** The page where the person adds repositories to the GitHub installation. */
export const installMore = (host: string): Promise<{ url: string }> => api(`/connections/${host}/install`, post());
export const reconnectUrl = (host: string): string => `/auth/${host}/login`;
export const disconnect = (host: string): Promise<{ ok: true }> => api(`/connections/${host}`, { method: 'DELETE' });
const integration = (id: string): string => `/connections/integrations/${encodeURIComponent(id)}`;
const signIn = (id: string, session?: string): string =>
  `${integration(id)}/sign-in${session === undefined ? '' : `/${encodeURIComponent(session)}`}`;
/** Every integration of the Connections page, as the person sees it. */
export const getIntegrationCards = (): Promise<IntegrationCardsView> =>
  api<IntegrationCardsView>('/connections/integrations');
/** Tests the fields, stores them when the provider accepts them, and returns the card. */
export const saveIntegration = (id: string, fields: Record<string, string>): Promise<ConnectionCard> =>
  api<ConnectionCard>(integration(id), { method: 'PUT', body: JSON.stringify({ fields }) });
export const testIntegration = (id: string): Promise<ConnectionCard> =>
  api<ConnectionCard>(`${integration(id)}/test`, post());
export const disconnectIntegration = (id: string): Promise<unknown> => api(integration(id), { method: 'DELETE' });
export const startSignIn = (id: string): Promise<SignInView> => api<SignInView>(signIn(id), post());
export const sendSignInCode = (id: string, session: string, code: string): Promise<SignInView> =>
  api<SignInView>(`${signIn(id, session)}/code`, post({ code }));
export const getSignIn = (id: string, session: string): Promise<SignInView> => api<SignInView>(signIn(id, session));
/** The manifest form for a new GitHub App. The old app and its connections stay until GitHub returns the new one. */
export const replaceApp = (): Promise<{ action: string; manifest: Record<string, unknown> }> =>
  api('/connections/github/app', post());
/** The person's own settings with the server defaults, the connected runtimes and the env-only settings. */
export const getSettings = (): Promise<SettingsView> => api<SettingsView>('/settings');
export const saveSettings = (body: SettingsBody): Promise<SettingsView> =>
  api<SettingsView>('/settings', { method: 'PUT', body: JSON.stringify(body) });
export const logout = (): Promise<unknown> => api('/auth/logout', post());
export const getReadiness = (): Promise<ReadinessView> => api<ReadinessView>('/readiness');
/** One page of the run list for a part and a filter text; `cursor` asks for the page after the one that gave it. */
export const listRuns = (query: { part: Part; q: string; cursor?: string }): Promise<RunsPage> => {
  const params = new URLSearchParams({ part: query.part });
  if (query.q !== '') {
    params.set('q', query.q);
  }
  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }
  return api<RunsPage>(`/runs?${params}`);
};
/** The statistics of the runs started in the last `days` local days (0: all of them). `tz` is `getTimezoneOffset()`. */
export const getStats = (days: number, tz: number): Promise<StatsView> =>
  api<StatsView>(`/stats?days=${days}&tz=${tz}`);
/** The latest finished items of the Overview's Done lately, newest first. */
export const getDoneLately = (): Promise<DoneLatelyItem[]> => api<DoneLatelyItem[]>('/overview/done');
export const getFlow = (key: string): Promise<FlowView> => api<FlowView>(run(key));
export const getStep = (key: string, name: string): Promise<StepView> => api<StepView>(step(key, name));
/** The events asked for in one page: the server's MAX_LIMIT. */
const EVENT_PAGE = 500;
/** The events of one step, or of every step of the run when `name` is null. */
export const getStepEvents = (key: string, name: string | null, after: number): Promise<StepEventPage> =>
  api<StepEventPage>(
    `${run(key)}/events?${name === null ? '' : `step=${encodeURIComponent(name)}&`}after=${after}&limit=${EVENT_PAGE}`,
  );
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
/** Sends a message to the planner of the run, with the ids of the uploaded files; returns the run as it is now. */
export const sendPlanChat = (key: string, message: string, attachments: string[] = []): Promise<FlowView> =>
  api<FlowView>(`${run(key)}/plan-chat`, post({ message, ...(attachments.length > 0 ? { attachments } : {}) }));
export const resumeRun = (key: string): Promise<unknown> => api(`${run(key)}/resume`, post());
export const stopRun = (key: string): Promise<unknown> => api(`${run(key)}/stop`, post());
export const skipTask = (key: string, taskId: string): Promise<unknown> =>
  api(`${run(key)}/skip-task`, post({ taskId } satisfies SkipTaskBody));
export const rebaseRun = (key: string): Promise<unknown> => api(`${run(key)}/rebase`, post());
export const replayStep = (key: string, name: string, body: ReplayBody): Promise<unknown> =>
  api(`${step(key, name)}/replay`, post(body));
export const removeRun = (key: string): Promise<unknown> => api(run(key), { method: 'DELETE' });

const token = (id: number): string => `/tokens/${id}`;
export const listTokens = (): Promise<TokensView> => api<TokensView>('/tokens');
/** Makes a token for the signed-in person; the value is in the answer once. */
export const createToken = (body: CreateTokenBody): Promise<CreatedTokenView> =>
  api<CreatedTokenView>('/tokens', post(body));
export const useExistingToken = (body: UseTokenBody): Promise<unknown> => api('/tokens/existing', post(body));
export const revokeToken = (id: number): Promise<unknown> => api(token(id), { method: 'DELETE' });
/** Keeps one file on the server for a message or a new run to take by its id; the body is the raw file. */
export const uploadFile = (file: Blob, name: string): Promise<UploadView> =>
  api<UploadView>(`/uploads?name=${encodeURIComponent(name)}`, {
    ...post(),
    body: file,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
