import { expect, test } from 'bun:test';
import { sqliteConnectionUrl } from './sqlite-connection';

test('preserves SQLite paths and other options while enforcing one connection', () => {
  expect(sqliteConnectionUrl('file:./uploads/inker.db')).toBe('file:./uploads/inker.db?connection_limit=1');
  expect(sqliteConnectionUrl('file:C:/My Files/inker.db?socket_timeout=5&connection_limit=9&connection_limit=8'))
    .toBe('file:C:/My Files/inker.db?socket_timeout=5&connection_limit=1');
});
