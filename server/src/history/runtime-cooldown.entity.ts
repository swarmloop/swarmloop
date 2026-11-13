import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** One runtime whose provider limit has not ended. All runs share it, because they share the subscription. */
@Entity('runtime_cooldowns')
export class RuntimeCooldownEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', unique: true })
  runtime!: string;

  /** When the runtime may be used again, ISO 8601 UTC. */
  @Column({ type: 'text' })
  until!: string;

  /** 1 when `until` is the reset the provider named, 0 when it is the default cooldown. */
  @Column({ name: 'reset_known', type: 'integer' })
  resetKnown!: number;
}
