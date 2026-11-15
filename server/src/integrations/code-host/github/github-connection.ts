import { githubEndpoints } from './github-login';
import type { Connection } from '../../connection';
import { CodeHostConnection, type ConnectionStore } from '../code-host-connection';

/** GitHub on the Connections page. The server's own base url and token key come from the host. */
export function githubConnection(host: { baseUrl: string; tokenKey: string }, store: ConnectionStore): Connection {
  return new CodeHostConnection(
    {
      host: 'github',
      label: 'GitHub',
      purpose: 'Clones, pushes and opens pull requests as you',
      tokenKey: host.tokenKey,
    },
    githubEndpoints({ GITHUB_BASE_URL: host.baseUrl }),
    store,
  );
}
