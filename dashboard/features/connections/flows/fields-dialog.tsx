'use client';

import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import { saveIntegration } from '../../../lib/endpoints';
import { messageOf, type FlowDialogProps } from './flow-types';

/** One input per field of the flow; the server tests the values before it stores them. */
export function FieldsDialog({ card, flow, hint, onClose, onSaved }: FlowDialogProps & { hint: string }): ReactElement {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await saveIntegration(card.id, values);
      onSaved();
      onClose();
    } catch (cause: unknown) {
      setError(messageOf(cause, 'the connection could not be saved'));
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} aria-labelledby={`${card.id}-flow-title`} fullWidth maxWidth="xs">
      <form onSubmit={(event) => void save(event)}>
        <DialogTitle id={`${card.id}-flow-title`}>{flow.label}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <DialogContentText>{hint}</DialogContentText>
          {flow.helpUrl ? (
            <Link href={flow.helpUrl} target="_blank" rel="noopener noreferrer">
              Open the page where the token is made
            </Link>
          ) : null}
          {flow.fields.map((field) => (
            <TextField
              key={field.name}
              label={field.label}
              type={field.secret ? 'password' : 'text'}
              autoComplete={field.secret ? 'off' : undefined}
              value={values[field.name] ?? ''}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
              size="small"
              fullWidth
            />
          ))}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={saving}>
            Save
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
