import { describe, expect, test } from 'bun:test';
import { PinAuthService } from './pin-auth.service';
import { createMock } from '../test/mocks/helpers';

describe('PinAuthService compatibility adapter', () => {
  test('delegates legacy validation to the persistent session service', async () => {
    let callCount = 0;
    const validate = createMock().mockImplementation(async () => {
      callCount += 1;
      return callCount === 1 ? { sessionId: 'session-1' } : null;
    });
    const service = new PinAuthService({ validate } as never);

    expect(await service.validateSession('valid')).toBe(true);
    expect(await service.validateSession('invalid')).toBe(false);
    expect(validate.calls.map((call: unknown[]) => call[0])).toEqual(['valid', 'invalid']);
  });
});
