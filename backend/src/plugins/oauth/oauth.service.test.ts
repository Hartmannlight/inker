import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import type { EncryptionService } from '../../common/services/encryption.service';
import { OAuthService } from './oauth.service';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function service(decryptedState = '{}'): OAuthService {
  const provider = {
    clientId: 'client', clientSecret: 'secret', authUrl: 'https://provider.test/auth',
    tokenUrl: 'https://provider.test/token',
  };
  const config = {
    get: (key: string) => key === 'oauth.providers' ? { example: provider } : 'https://inker.test/api',
  } as unknown as ConfigService;
  const prisma = { pluginInstance: { findUnique: mock(), update: mock() } } as unknown as PrismaService;
  const encryption = {
    encrypt: (value: string) => value,
    decrypt: () => decryptedState,
  } as unknown as EncryptionService;
  return new OAuthService(config, prisma, encryption);
}

describe('OAuthService trust boundaries', () => {
  it('rejects malformed decrypted state before network or database access', async () => {
    const network = spyOn(globalThis, 'fetch');
    await expect(service('{"instanceId":0,"provider":"../bad"}').handleCallback('code', 'state'))
      .rejects.toThrow('Invalid OAuth state');
    expect(network).not.toHaveBeenCalled();
  });

  it('does not expose an upstream token error body', async () => {
    globalThis.fetch = mock(async () => new Response('private-provider-detail', { status: 401 })) as unknown as typeof fetch;
    const exchange = (service() as unknown as {
      exchangeCode(code: string, config: object): Promise<unknown>;
    }).exchangeCode;

    await expect(exchange.call(service(), 'code', {
      clientId: 'client', clientSecret: 'secret', authUrl: '', tokenUrl: 'https://provider.test/token',
    })).rejects.toThrow('OAuth token exchange failed with status 401');
  });

  it('rejects successful HTTP responses without a valid access token', async () => {
    globalThis.fetch = mock(async () => new Response('{"expires_in":3600}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const instance = service() as unknown as {
      exchangeCode(code: string, config: object): Promise<unknown>;
    };

    await expect(instance.exchangeCode('code', {
      clientId: 'client', clientSecret: 'secret', authUrl: '', tokenUrl: 'https://provider.test/token',
    })).rejects.toThrow('OAuth token exchange returned an invalid response');
  });
});
