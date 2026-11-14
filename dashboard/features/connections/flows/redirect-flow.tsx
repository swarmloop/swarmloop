import type { ReactElement } from 'react';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import type { ConnectionFlow } from '@contract/connections';

/** A sign-in on the provider's own page: a link, so Tab reaches it and Enter follows it. */
export function RedirectFlow({ flow, connected }: { flow: ConnectionFlow; connected: boolean }): ReactElement {
  return (
    <Button variant="outlined" size="small" component={Link} href={flow.url ?? '#'}>
      {connected ? 'Reconnect' : flow.label}
    </Button>
  );
}
