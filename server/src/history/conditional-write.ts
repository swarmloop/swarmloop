import type { ObjectLiteral, Repository } from 'typeorm';
import { SwarmloopError } from '../core/swarmloop-error';

/**
 * Writes `changed` and `extra` to the row with this id, on the condition that each changed column still holds the
 * value `readOf` gives for it. A value is compared in its stored form, so null, a boolean and a JSON column match
 * the way the database holds them. Returns whether a row was written.
 */
export async function conditionalUpdate<T extends ObjectLiteral>(
  repository: Repository<T>,
  id: number,
  changed: Partial<T>,
  readOf: (column: string) => unknown,
  extra: Partial<T> = {},
): Promise<boolean> {
  const { metadata } = repository;
  const driver = repository.manager.connection.driver;
  const conditions = ['id = :id'];
  const parameters: Record<string, unknown> = { id };
  Object.keys(changed).forEach((property, index) => {
    const column = metadata.findColumnWithPropertyName(property);
    if (!column) {
      throw new SwarmloopError(`${metadata.name} has no column ${property}`);
    }
    conditions.push(`${column.databaseName} IS :read${index}`);
    parameters[`read${index}`] = driver.preparePersistentValue(readOf(property), column);
  });
  const result = await repository
    .createQueryBuilder()
    .update()
    .set({ ...changed, ...extra })
    .where(conditions.join(' AND '), parameters)
    .execute();
  return Boolean(result.affected);
}
