import { randomUUID } from 'crypto';

/** One id per server process. A run owned by it with an active attempt is held, whatever the PID says. */
export const SERVER_INSTANCE = randomUUID();
