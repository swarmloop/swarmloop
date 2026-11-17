import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/** A person of the server, keyed by the login that sessions and settings use. `role` is `admin` or `member`. */
@Entity('people')
export class PersonEntity {
  @PrimaryColumn({ type: 'text' })
  login!: string;

  @Column({ type: 'text' })
  role!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

/** A personal API token. Only the sha256 of the value is stored. */
@Entity('personal_tokens')
@Index('IDX_personal_tokens_token_hash', ['tokenHash'], { unique: true })
export class PersonalTokenEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  login!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'token_hash', type: 'text' })
  tokenHash!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ name: 'last_used_at', type: 'text', nullable: true })
  lastUsedAt!: string | null;

  @Column({ name: 'expires_at', type: 'text', nullable: true })
  expiresAt!: string | null;
}
