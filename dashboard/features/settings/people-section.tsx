'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import type { PersonView } from '@contract/people';
import { personLabel } from '@contract/people';
import { listPeople, setRole } from '../../lib/endpoints';
import { ConfirmDialog } from '../shell';

const reason = (cause: unknown, fallback: string): string => (cause instanceof Error ? cause.message : fallback);

/** Admins only: who is a member and who an admin, with the change of role. */
export function PeopleSection(): ReactElement {
  const [people, setPeople] = useState<PersonView[]>([]);
  const [taking, setTaking] = useState<PersonView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listPeople().then(
      (view) => setPeople(view.people),
      (cause: unknown) => setError(reason(cause, 'people could not be read')),
    );
  }, []);
  useEffect(load, [load]);

  async function makeAdmin(person: PersonView): Promise<void> {
    setError(null);
    try {
      await setRole(person.login, 'admin');
      load();
    } catch (cause: unknown) {
      setError(reason(cause, 'the role could not be changed'));
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Table size="small" aria-label="People">
        <TableHead>
          <TableRow>
            <TableCell>Person</TableCell>
            <TableCell>Role</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {people.map((person) => (
            <TableRow key={person.login}>
              <TableCell>{personLabel(person.login)}</TableCell>
              <TableCell>{person.role}</TableCell>
              <TableCell>
                {person.role === 'member' ? (
                  <Button size="small" onClick={() => void makeAdmin(person)}>
                    Make admin
                  </Button>
                ) : (
                  <Button size="small" color="error" onClick={() => setTaking(person)}>
                    Take back admin
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={taking !== null}
        title={`Take back admin from ${taking?.login}?`}
        body="They become a member and can no longer replace apps they did not make or pause the server."
        verb="Take back admin"
        tone="danger"
        onConfirm={async () => {
          if (taking) {
            setError(null);
            await setRole(taking.login, 'member');
            load();
          }
        }}
        onClose={() => setTaking(null)}
      />
    </Box>
  );
}
