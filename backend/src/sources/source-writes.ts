import { sqliteWrite } from '../common/utils/sqlite-write.util';
export { isRetryableSqliteWriteError, sqliteWrite } from '../common/utils/sqlite-write.util';

/** Source operations retain the domain error while sharing the process-wide SQLite writer. */
export function sourceWrite<T>(client: object, operation: () => Promise<T>) {
  return sqliteWrite(client, operation, 'SOURCE_WRITE_CAPACITY');
}
