'use client';

import type { FormEvent, ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';
import type { CreatedTokenView, TokenLifetime, TokenView } from '@contract/people';
import { createToken, listTokens, revokeToken, useExistingToken as adoptToken } from '../../lib/endpoints';
import { localTime } from '../../lib/format';
import { usePhone } from '../../lib/use-phone';
import { Placeholders } from '../overview';
import { ConfirmDialog } from '../shell';

const LIFETIMES: { label: string; value: string }[] = [
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: 'Never', value: 'never' },
];

const lifetimeOf = (value: string): TokenLifetime => (value === 'never' ? null : value === '30' ? 30 : 90);
const reason = (cause: unknown, fallback: string): string => (cause instanceof Error ? cause.message : fallback);

/** A form's fields and its button: one column on a phone, one row from 900 px. */
const formSx = (phone: boolean): SxProps<Theme> =>
  phone ? { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 1 } : { display: 'flex', gap: 1 };

/** The submit button in a row that wraps, so a row of buttons that does not fit wraps as a row. */
function ButtonRow({ children }: { children: ReactNode }): ReactElement {
  return <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{children}</Box>;
}

function LifetimeField({ value, onChange }: { value: string; onChange: (value: string) => void }): ReactElement {
  return (
    <TextField select size="small" label="Expires" value={value} onChange={(event) => onChange(event.target.value)}>
      {LIFETIMES.map(({ label, value: item }) => (
        <MenuItem key={item} value={item}>
          {label}
        </MenuItem>
      ))}
    </TextField>
  );
}

function CreateTokenForm({
  onCreated,
  onError,
}: {
  onCreated: (made: CreatedTokenView) => void;
  onError: (text: string) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const phone = usePhone();
  const [lifetime, setLifetime] = useState('30');

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const made = await createToken({ name, expiresInDays: lifetimeOf(lifetime) });
      setName('');
      onCreated(made);
    } catch (cause: unknown) {
      onError(reason(cause, 'the token could not be created'));
    }
  }

  return (
    <Box component="form" aria-label="Create token" onSubmit={(event) => void submit(event)} sx={formSx(phone)}>
      <TextField size="small" label="Name" value={name} onChange={(event) => setName(event.target.value)} required />
      <LifetimeField value={lifetime} onChange={setLifetime} />
      <ButtonRow>
        <Button type="submit" variant="contained">
          Create token
        </Button>
      </ButtonRow>
    </Box>
  );
}

function UseTokenForm({ onUsed, onError }: { onUsed: () => void; onError: (text: string) => void }): ReactElement {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const phone = usePhone();
  const [lifetime, setLifetime] = useState('never');

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await adoptToken({ name, value, expiresInDays: lifetimeOf(lifetime) });
      setName('');
      setValue('');
      onUsed();
    } catch (cause: unknown) {
      onError(reason(cause, 'the token could not be saved'));
    }
  }

  return (
    <Box
      component="form"
      aria-label="Use an existing token"
      onSubmit={(event) => void submit(event)}
      sx={formSx(phone)}
    >
      <TextField
        size="small"
        label="Token name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />
      <TextField
        size="small"
        label="Token value"
        type="password"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        required
      />
      <LifetimeField value={lifetime} onChange={setLifetime} />
      <ButtonRow>
        <Button type="submit" variant="outlined">
          Use token
        </Button>
      </ButtonRow>
    </Box>
  );
}

/** The value of a new token, shown once: closing the dialog drops it. */
function ValueDialog({ made, onClose }: { made: CreatedTokenView | null; onClose: () => void }): ReactElement {
  return (
    <Dialog open={made !== null} onClose={onClose}>
      <DialogTitle>Token created</DialogTitle>
      <DialogContent>
        <Typography>Copy it now: it will not be shown again.</Typography>
        <Typography component="code" sx={{ display: 'block', mt: 1, wordBreak: 'break-all', fontFamily: 'monospace' }}>
          {made?.value}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void navigator.clipboard.writeText(made?.value ?? '')}>Copy</Button>
        <Button variant="contained" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function TokenTable({ tokens, onRevoke }: { tokens: TokenView[]; onRevoke: (token: TokenView) => void }): ReactElement {
  return (
    <Box data-testid="tokens-scroll" sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="API tokens">
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Created</TableCell>
            <TableCell>Last used</TableCell>
            <TableCell>Expires</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {tokens.map((token) => (
            <TableRow key={token.id}>
              <TableCell>{token.name}</TableCell>
              <TableCell>{localTime(token.createdAt)}</TableCell>
              <TableCell>{token.lastUsedAt ? localTime(token.lastUsedAt) : 'never'}</TableCell>
              <TableCell>{token.expiresAt ? localTime(token.expiresAt) : 'never'}</TableCell>
              <TableCell>
                <Button size="small" color="error" onClick={() => onRevoke(token)}>
                  Revoke
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

/** The person's personal API tokens: list, create, paste an existing one, revoke. */
export function ApiTokensSection(): ReactElement {
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [made, setMade] = useState<CreatedTokenView | null>(null);
  const [revoking, setRevoking] = useState<TokenView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listTokens().then(
      (view) => setTokens(view.tokens),
      (cause: unknown) => setError(reason(cause, 'tokens could not be read')),
    );
  }, []);
  useEffect(load, [load]);

  function fail(text: string): void {
    setError(text);
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Typography color="text.secondary">
        A token acts as you: your keys, your agents and your settings. Make it here, then give it to a script or the
        CLI.
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {tokens ? (
        <TokenTable tokens={tokens} onRevoke={setRevoking} />
      ) : error ? null : (
        <Placeholders count={3} height={36} testId="tokens-placeholder" grid={false} />
      )}
      <CreateTokenForm
        onCreated={(token) => {
          setError(null);
          setMade(token);
          load();
        }}
        onError={fail}
      />
      <UseTokenForm
        onUsed={() => {
          setError(null);
          load();
        }}
        onError={fail}
      />
      <ValueDialog made={made} onClose={() => setMade(null)} />
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.name}?`}
        body="Whatever uses this token stops working at once."
        verb="Revoke"
        tone="danger"
        onConfirm={async () => {
          if (revoking) {
            await revokeToken(revoking.id);
            load();
          }
        }}
        onClose={() => setRevoking(null)}
      />
    </Box>
  );
}
