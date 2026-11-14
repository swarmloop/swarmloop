import type { ConnectionFlow, ConnectionFlowField } from '../contract/connections';
import type { ConnectionProbe, ConnectionTestResult } from './connection';

const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens';

const FIELDS: ConnectionFlowField[] = [
  { name: 'JIRA_BASE_URL', label: 'Site URL', secret: false },
  { name: 'JIRA_EMAIL', label: 'Email', secret: false },
  { name: 'JIRA_API_TOKEN', label: 'API token', secret: true },
];

/** The form Jira and Confluence share: one Atlassian site, one account, one API token. */
export function atlassianFlow(label: string): ConnectionFlow {
  return { kind: 'form', label, fields: FIELDS, helpUrl: TOKEN_PAGE };
}

interface AtlassianValues {
  JIRA_BASE_URL?: string;
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
}

/** The site address without a trailing slash, or null when it is not an http(s) address. */
function siteBase(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url.trim().replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/** The base address and the Basic-auth headers of a site, from a form's values or from env. */
export function atlassianSite(values: AtlassianValues): { base: string; headers: Record<string, string> } {
  const token = Buffer.from(`${values.JIRA_EMAIL ?? ''}:${values.JIRA_API_TOKEN ?? ''}`).toString('base64');
  return {
    base: (values.JIRA_BASE_URL ?? '').replace(/\/$/, ''),
    headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
  };
}

/** Atlassian's own message of a failed answer. */
function failureMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; errorMessages?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) {
      return parsed.message;
    }
    const first = Array.isArray(parsed.errorMessages) ? (parsed.errorMessages as unknown[])[0] : undefined;
    if (typeof first === 'string' && first) {
      return first;
    }
  } catch {
    // The body is not JSON; the status says what happened.
  }
  return `Atlassian answered ${status}`;
}

async function read(
  probe: ConnectionProbe,
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true; body: string } | { ok: false; message: string }> {
  try {
    const response = await probe.request(url, headers);
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, message: failureMessage(response.status, response.body) };
    }
    return { ok: true, body: response.body };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'the site did not answer' };
  }
}

function accountName(body: string, email: string): string {
  try {
    const parsed = JSON.parse(body) as { displayName?: unknown };
    return typeof parsed.displayName === 'string' && parsed.displayName ? parsed.displayName : email;
  } catch {
    return email;
  }
}

/** Reads the account of the form's login and one sample from the site; the first refusal is the answer. */
export async function testAtlassianSite(
  fields: Record<string, string>,
  probe: ConnectionProbe,
  paths: { account: string; sample: string },
): Promise<ConnectionTestResult> {
  const given = { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '', ...fields };
  if (siteBase(given.JIRA_BASE_URL) === null) {
    return { ok: false, message: 'The site URL must be a web address such as https://example.atlassian.net' };
  }
  const { base, headers } = atlassianSite(given);
  const account = await read(probe, `${base}${paths.account}`, headers);
  if (!account.ok) {
    return account;
  }
  const sample = await read(probe, `${base}${paths.sample}`, headers);
  if (!sample.ok) {
    return sample;
  }
  return { ok: true, account: accountName(account.body, given.JIRA_EMAIL) };
}
