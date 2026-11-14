import { Column, Entity, PrimaryColumn } from 'typeorm';

/** The GitHub App or GitLab application of one host. Every secret column is ciphertext. */
@Entity('host_apps')
export class HostAppEntity {
  /** The host name, `github` or `gitlab`. */
  @PrimaryColumn({ name: 'id', type: 'text' })
  host!: string;

  @Column({ name: 'app_id', type: 'text' })
  appId!: string;

  @Column({ type: 'text' })
  slug!: string;

  @Column({ name: 'client_id', type: 'text' })
  clientId!: string;

  @Column({ name: 'client_secret', type: 'text' })
  clientSecret!: string;

  @Column({ name: 'private_key', type: 'text' })
  privateKey!: string;

  /** The login of the person who made the app, or `machine`. Null for an app made earlier. */
  @Column({ name: 'made_by', type: 'text', nullable: true })
  madeBy!: string | null;
}

/** One person's grant on one host. The tokens are ciphertext; `status` is `ok` or `broken`. */
@Entity('connections')
export class ConnectionEntity {
  /** `<host>:<login>`. */
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  host!: string;

  @Column({ type: 'text' })
  login!: string;

  @Column({ name: 'access_token', type: 'text' })
  accessToken!: string;

  @Column({ name: 'refresh_token', type: 'text' })
  refreshToken!: string;

  /** ISO 8601 UTC, null for a token that does not expire. */
  @Column({ name: 'expires_at', type: 'text', nullable: true })
  expiresAt!: string | null;

  @Column({ name: 'refreshed_at', type: 'text', nullable: true })
  refreshedAt!: string | null;

  @Column({ type: 'text' })
  status!: 'ok' | 'broken';

  @Column({ name: 'installation_id', type: 'text', nullable: true })
  installationId!: string | null;

  /** `all` or `selected` repositories of the GitHub installation. */
  @Column({ type: 'text', nullable: true })
  selection!: string | null;
}

/** One personal setting: the person's login, the setting key (`agents`, `split`) and its value as JSON text. */
@Entity('user_settings')
export class UserSettingEntity {
  @PrimaryColumn({ type: 'varchar' })
  login!: string;

  @PrimaryColumn({ type: 'varchar' })
  key!: string;

  @Column({ type: 'text' })
  value!: string;
}

/** One person's secret for one integration. `secret` is ciphertext of the JSON fields; `last4` is all the card shows. */
@Entity('integration_secrets')
export class IntegrationSecretEntity {
  /** `<connection>:<login>`. */
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  connection!: string;

  @Column({ type: 'text' })
  login!: string;

  @Column({ type: 'text' })
  secret!: string;

  @Column({ type: 'text' })
  last4!: string;

  /** The account the provider named when the secret was tested. */
  @Column({ type: 'text', nullable: true })
  account!: string | null;

  @Column({ type: 'text' })
  status!: 'ok' | 'broken';

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ name: 'saved_at', type: 'text' })
  savedAt!: string;
}
