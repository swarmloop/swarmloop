/** The largest file one upload takes. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** A file kept with a run: its name inside the run's attachments folder and its size in bytes. */
export interface AttachmentRef {
  id: string;
  name: string;
  size: number;
}

/** What `POST /uploads` answers: the staged file, to be sent by id with a message or a new run. */
export type UploadView = AttachmentRef;
