import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  csrfHeadersFor,
  discardLegacyAdminToken,
  rememberCsrfFromHeaders,
  resetCsrfToken,
} from './admin-session';

describe('browser admin session state', () => {
  beforeEach(() => resetCsrfToken());
  afterEach(() => vi.restoreAllMocks());

  test('keeps CSRF in memory and sends it only for state-changing requests', () => {
    rememberCsrfFromHeaders({ 'x-csrf-token': 'session-bound-csrf' });
    expect(csrfHeadersFor('get')).toEqual({});
    expect(csrfHeadersFor('POST')).toEqual({ 'X-CSRF-Token': 'session-bound-csrf' });
    expect(csrfHeadersFor('patch')).toEqual({ 'X-CSRF-Token': 'session-bound-csrf' });
  });

  test('does not persist the CSRF token and clears it on logout', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    rememberCsrfFromHeaders({ 'x-csrf-token': 'never-persist-this' });
    expect(setItem).not.toHaveBeenCalled();
    resetCsrfToken();
    expect(csrfHeadersFor('POST')).toEqual({});
  });

  test('removes the historical bearer token without ever reading it', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    discardLegacyAdminToken();
    expect(getItem).not.toHaveBeenCalled();
    expect(removeItem).toHaveBeenCalledWith('inker_session');
  });
});
