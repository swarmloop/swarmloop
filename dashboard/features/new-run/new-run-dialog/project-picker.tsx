'use client';

import { type ReactElement, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { RemoteEntry, RemoteListView } from '@contract/api';
import { NewRepositoryDialog } from './new-repository-dialog';

interface Option {
  name: string;
  label: string;
  /** Set for a repository of a code host that is not cloned yet. */
  remote?: RemoteEntry;
}

/** Local folders first, then the host repositories that are not cloned yet. */
function optionsOf(local: readonly string[], remote: RemoteListView | null): Option[] {
  const pending = (remote?.repositories ?? []).filter((entry) => !entry.cloned && !local.includes(entry.name));
  return [
    ...local.map((name) => ({ name, label: name })),
    ...pending.map((entry) => ({ name: entry.name, label: `${entry.owner}/${entry.name}`, remote: entry })),
  ];
}

export function ProjectPicker({
  frozenProjects,
  projectOptions,
  pickedProjects,
  onChange,
  remote = null,
  onCreated,
}: {
  frozenProjects: boolean;
  projectOptions: string[];
  pickedProjects: string[];
  onChange: (value: string[]) => void;
  remote?: RemoteListView | null;
  onCreated?: (entry: RemoteEntry) => void;
}): ReactElement {
  const [creating, setCreating] = useState(false);
  const options = optionsOf(projectOptions, remote);
  const value = pickedProjects.map((name) => options.find((option) => option.name === name) ?? { name, label: name });
  const owners = remote?.owners ?? [];
  const createReason =
    owners.length > 0 ? null : (remote?.reason ?? 'No account or organization allows creating repositories');

  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      <Autocomplete
        multiple
        disableCloseOnSelect
        disableClearable={frozenProjects}
        options={options}
        value={value}
        getOptionLabel={(option) => option.label}
        getOptionKey={(option) => option.label}
        getOptionDisabled={(option) => Boolean(option.remote?.blocked)}
        isOptionEqualToValue={(option, picked) => option.name === picked.name}
        onChange={(_event, picked) => onChange([...new Set(picked.map((option) => option.name))])}
        noOptionsText={remote?.reason ?? 'No projects'}
        renderOption={(props, option) => {
          const { key, ...itemProps } = props;
          return (
            <Box component="li" key={key} {...itemProps} sx={{ gap: 1 }}>
              {option.remote ? <VisibilityIcon visibility={option.remote.visibility} /> : null}
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap>
                  {option.label}
                </Typography>
                {option.remote?.blocked ? (
                  <Typography variant="caption" color="text.secondary">
                    {option.remote.blocked}
                  </Typography>
                ) : null}
              </Box>
              {option.remote ? <Chip size="small" variant="outlined" label="not cloned" /> : null}
            </Box>
          );
        }}
        renderValue={
          frozenProjects
            ? (picked, getItemProps) =>
                picked.map((option, index) => {
                  const { key, ...itemProps } = getItemProps({ index });
                  return <Chip key={key} {...itemProps} label={option.label} onDelete={undefined} />;
                })
            : undefined
        }
        renderInput={(params) => <TextField {...params} label="Projects" />}
        slotProps={{
          popper: { sx: { zIndex: (theme) => theme.zIndex.modal + 1 } },
          paper: {
            sx: {
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider',
              boxShadow: '0 8px 24px rgba(28, 25, 21, 0.16)',
            },
          },
          listbox: { sx: { maxHeight: 220 } },
        }}
      />
      <Box>
        <Tooltip title={createReason ?? ''}>
          <span>
            <Button
              size="small"
              startIcon={<AddIcon />}
              disabled={createReason !== null}
              onClick={() => setCreating(true)}
            >
              New repository
            </Button>
          </span>
        </Tooltip>
      </Box>
      <NewRepositoryDialog
        open={creating}
        owners={owners}
        allowedNames={remote?.allowedNames ?? []}
        onClose={() => setCreating(false)}
        onCreated={(entry) => onCreated?.(entry)}
      />
    </Box>
  );
}

function VisibilityIcon({ visibility }: { visibility: RemoteEntry['visibility'] }): ReactElement {
  return visibility === 'public' ? (
    <PublicOutlinedIcon fontSize="small" titleAccess="public" color="action" />
  ) : (
    <LockOutlinedIcon fontSize="small" titleAccess="private" color="action" />
  );
}
