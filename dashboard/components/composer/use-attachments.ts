import { useCallback, useState } from 'react';
import type { AttachmentRef } from '@contract/attachments';
import { uploadFile } from '../../lib/endpoints';

interface Attachments {
  files: AttachmentRef[];
  /** Files still on their way to the server. */
  busy: boolean;
  /** The server's reason for the last refused file, in plain words. */
  problem: string | null;
  add: (files: readonly File[]) => void;
  remove: (id: string) => void;
}

/** Each file uploads at once and stays as one chip until it is removed. */
export function useAttachments(): Attachments {
  const [files, setFiles] = useState<AttachmentRef[]>([]);
  const [pending, setPending] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const add = useCallback((picked: readonly File[]): void => {
    setProblem(null);
    for (const file of picked) {
      setPending((count) => count + 1);
      uploadFile(file, file.name || 'file')
        .then((ref) => setFiles((current) => [...current, ref]))
        .catch((cause: unknown) =>
          setProblem(cause instanceof Error ? cause.message : `${file.name || 'The file'} could not be uploaded`),
        )
        .finally(() => setPending((count) => count - 1));
    }
  }, []);

  const remove = useCallback((id: string): void => setFiles((current) => current.filter((ref) => ref.id !== id)), []);

  return { files, busy: pending > 0, problem, add, remove };
}
