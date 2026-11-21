import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** A message of the conversation with a backlog's planner, written once per key. The turn is empty while it waits. */
@Entity('backlog_messages')
@Index('IDX_backlog_messages_backlog_key', ['backlogId', 'messageKey'], { unique: true })
export class BacklogMessageEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'backlog_id', type: 'integer' })
  backlogId!: number;

  @Column({ name: 'message_key', type: 'text' })
  messageKey!: string;

  @Column({ type: 'text' })
  author!: string;

  @Column({ type: 'text', default: 'message' })
  kind!: string;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'integer', nullable: true })
  proposes!: number | null;

  @Column({ type: 'text', nullable: true })
  turn!: string | null;

  @Column({ type: 'text', default: '[]' })
  attachments!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

/** A turn of a backlog's planner, found by its key. */
@Entity('backlog_turns')
@Index('IDX_backlog_turns_turn_key', ['turnKey'], { unique: true })
export class BacklogTurnEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'backlog_id', type: 'integer' })
  backlogId!: number;

  @Column({ name: 'turn_key', type: 'text' })
  turnKey!: string;

  @Column({ type: 'text' })
  status!: string;

  @Column({ type: 'text', default: '' })
  reason!: string;

  @Column({ name: 'next_try_at', type: 'text', nullable: true })
  nextTryAt!: string | null;

  @Column({ type: 'text', default: '' })
  runtime!: string;

  @Column({ type: 'text', default: '' })
  model!: string;

  @Column({ type: 'text', nullable: true })
  effort!: string | null;

  @Column({ name: 'tokens_in', type: 'integer', default: 0 })
  tokensIn!: number;

  @Column({ name: 'tokens_out', type: 'integer', default: 0 })
  tokensOut!: number;

  @Column({ type: 'float', default: 0 })
  usd!: number;

  @Column({ name: 'duration_ms', type: 'integer', default: 0 })
  durationMs!: number;

  /** The path of the transcript of the turn's agent visit. */
  @Column({ type: 'text', default: '' })
  transcript!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}
