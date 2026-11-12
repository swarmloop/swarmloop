import { Column, Entity, PrimaryColumn } from 'typeorm';

/** A login session. The cookie holds `id`; the row says who it is and when it ends. */
@Entity('sessions')
export class SessionEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  user!: string;

  @Column({ type: 'text' })
  provider!: string;

  /** ISO 8601 UTC. */
  @Column({ name: 'expires_at', type: 'text' })
  expiresAt!: string;
}
