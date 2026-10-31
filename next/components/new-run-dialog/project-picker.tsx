'use client';

import Autocomplete from '@mui/material/Autocomplete';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';

export function ProjectPicker({
  frozenProjects,
  projectOptions,
  pickedProjects,
  onChange,
}: {
  frozenProjects: boolean;
  projectOptions: string[];
  pickedProjects: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <Autocomplete
      multiple
      disableCloseOnSelect
      disableClearable={frozenProjects}
      options={projectOptions}
      value={pickedProjects}
      onChange={(_event, value) => onChange(value)}
      renderValue={
        frozenProjects
          ? (value, getItemProps) =>
              value.map((option, index) => {
                const { key, ...itemProps } = getItemProps({ index });
                return <Chip key={key} {...itemProps} label={option} onDelete={undefined} />;
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
  );
}
