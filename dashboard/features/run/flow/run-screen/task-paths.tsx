import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/** `a/b/c.ts` as folder `a/b/` and file `c.ts`; a file in the root has no folder. */
function split(path: string): { folder: string; file: string } {
  const cut = path.lastIndexOf('/') + 1;
  return { folder: path.slice(0, cut), file: path.slice(cut) };
}

/** Paths grouped by folder in the order they first appear: the folder in the UI font, each file name in mono, with an optional mark after it. */
export function TaskPaths({ paths, mark }: { paths: string[]; mark?: (path: string) => string | null }): ReactElement {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const { folder } = split(path);
    groups.set(folder, [...(groups.get(folder) ?? []), path]);
  }
  return (
    <Box component="ul" sx={{ m: 0, pl: 2 }}>
      {[...groups.entries()].map(([folder, group]) => (
        <li key={folder}>
          {folder ? <Typography variant="body2">{folder}</Typography> : null}
          <Box component="ul" sx={{ m: 0, pl: folder ? 2 : 0, listStyle: 'none' }}>
            {group.map((path) => (
              <li key={path}>
                <Box component="span" sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>
                  {split(path).file}
                </Box>
                {mark?.(path) ? (
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    {mark(path)}
                  </Typography>
                ) : null}
              </li>
            ))}
          </Box>
        </li>
      ))}
    </Box>
  );
}
