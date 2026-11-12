import { Column, Entity, PrimaryColumn } from 'typeorm';

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
