import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** One credential of a runtime whose provider limit has not ended. The credential is a login, or `env` for the server's own. */
@Entity('credential_cooldowns')
@Unique('UQ_credential_cooldowns_runtime_credential', ['runtime', 'credential'])
export class CredentialCooldownEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  runtime!: string;

  @Column({ type: 'text' })
  credential!: string;

  /** When the credential may be used again, ISO 8601 UTC. */
  @Column({ type: 'text' })
  until!: string;

  /** 1 when `until` is the reset the provider named, 0 when it is the default cooldown. */
  @Column({ name: 'reset_known', type: 'integer' })
  resetKnown!: number;
}
