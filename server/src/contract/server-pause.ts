/** What a step and the dashboard say while the server is paused for a restart. */
export const SERVER_PAUSE_NOTE = 'The server is about to restart; this step starts right after it.';

/** The body of `GET /health`. */
export type HealthView = { status: 'ok'; paused: boolean; containers: number };

/** The body of `POST` and `DELETE /server/pause`, and the `server` socket event. */
export type ServerState = { paused: boolean };
