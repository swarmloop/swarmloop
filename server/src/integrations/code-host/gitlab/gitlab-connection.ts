import type { ConnectionsService } from '../../../auth/connections.service';
import { gitlabEndpoints } from '../../../auth/oauth-provider';
import type { Connection } from '../../connection';
import { CodeHostConnection } from '../code-host-connection';

/** GitLab on the Connections page. The server's own base url and token key come from the host. */
export function gitlabConnection(host: { baseUrl: string; tokenKey: string }, store: ConnectionsService): Connection {
  return new CodeHostConnection(
    {
      host: 'gitlab',
      label: 'GitLab',
      purpose: 'Clones, pushes and opens merge requests as you',
      tokenKey: host.tokenKey,
    },
    gitlabEndpoints({ GITLAB_BASE_URL: host.baseUrl }),
    store,
  );
}
