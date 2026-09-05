import { describe, expect, test } from 'bun:test';
import { runHttpConnector, validateHttpConnectorConfiguration } from './http-worker-connector';

describe('worker HTTP connector boundary', () => {
  test('normalizes a bounded public HTTP configuration', () => {
    expect(validateHttpConnectorConfiguration({
      url: 'https://example.com/feed.json', format: 'json', method: 'GET', jsonPath: '$.items', allowLocalNetwork: false,
    })).toEqual({
      url: 'https://example.com/feed.json', format: 'json', method: 'GET', jsonPath: '$.items', allowLocalNetwork: false,
    });
  });

  test('rejects credentials in URLs and unsafe request headers', async () => {
    expect(() => validateHttpConnectorConfiguration({
      url: 'https://user:password@example.com/data', format: 'json', method: 'GET', allowLocalNetwork: false,
    })).toThrow('SOURCE_CONNECTOR_INVALID_CONFIG');
    await expect(runHttpConnector({
      url: 'https://example.com/data', format: 'json', method: 'GET', allowLocalNetwork: false,
    }, { signal: new AbortController().signal, attempt: 1, secret: JSON.stringify({ Host: 'internal' }) }))
      .rejects.toThrow('HTTP_HEADERS_INVALID');
  });

  test('blocks internal destinations before making a provider request', async () => {
    await expect(runHttpConnector({
      url: 'http://localhost/private', format: 'json', method: 'GET', allowLocalNetwork: false,
    }, { signal: new AbortController().signal, attempt: 1 }))
      .rejects.toThrow('HTTP_NETWORK_BLOCKED');
  });
});
