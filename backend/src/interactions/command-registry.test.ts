import { describe, expect, mock, test } from 'bun:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { InteractionEvent, JsonObject } from '@inker/contracts';
import type { Prisma } from '@prisma/client';
import type { PlaybackService } from '../playback/playback.service';
import { CommandRegistry, type CommandHandler, type CommandPrincipal } from './command-registry';
import { ViewNextHandler } from './view-next.handler';

function commandHandler(action: string): CommandHandler {
  return {
    action, payloadSchemaVersion: '1.0',
    validate: mock((payload: JsonObject) => payload),
    execute: mock(async () => ({ result: { action } })),
  };
}

describe('CommandRegistry', () => {
  test('routes registered current and future actions without executing handlers', () => {
    const next = commandHandler('view.next'), future = commandHandler('future.clock.start');
    const registry = new CommandRegistry([next, future]);
    expect(registry.get('view.next')).toBe(next);
    expect(registry.get('future.clock.start')).toBe(future);
    expect(registry.get('view.previous')).toBeUndefined();
    expect(registry.get('VIEW.NEXT')).toBeUndefined();
    expect(registry.get('toString')).toBeUndefined();
    expect(next.validate).not.toHaveBeenCalled();
    expect(next.execute).not.toHaveBeenCalled();
    expect(future.validate).not.toHaveBeenCalled();
    expect(future.execute).not.toHaveBeenCalled();
  });

  test('supports an empty registry and exactly 32 distinct handlers', () => {
    expect(new CommandRegistry([]).get('view.next')).toBeUndefined();
    const handlers = Array.from({ length: 32 }, (_, index) => commandHandler('future.action' + index));
    const registry = new CommandRegistry(handlers);
    for (const handler of handlers) expect(registry.get(handler.action)).toBe(handler);
    expect(() => new CommandRegistry([...handlers, commandHandler('future.extra')]))
      .toThrow('COMMAND_REGISTRY_LIMIT');
  });

  test('rejects duplicate actions even when the supplied handlers differ', () => {
    expect(() => new CommandRegistry([commandHandler('view.next'), commandHandler('view.next')]))
      .toThrow('COMMAND_REGISTRY_INVALID');
  });

  test('only registers the supported payload schema version', () => {
    for (const version of ['1.1', '2.0', '', 1, null, undefined]) {
      const handler = { ...commandHandler('view.next'), payloadSchemaVersion: version } as unknown as CommandHandler;
      expect(() => new CommandRegistry([handler])).toThrow('COMMAND_REGISTRY_INVALID');
    }
  });

  test('accepts the 64-character dotted action boundary and rejects invalid grammar', () => {
    const boundary = 'a.' + 'b'.repeat(62);
    expect(new CommandRegistry([commandHandler(boundary)]).get(boundary)?.action).toBe(boundary);
    for (const action of ['', 'next', '.view', 'view.', 'view..next', 'View.next', 'view.Next',
      '1view.next', 'view.1next', 'view.next-action', 'view.next_action', 'view.next ',
      'view.néxt', boundary + 'b']) {
      expect(() => new CommandRegistry([commandHandler(action)])).toThrow('COMMAND_REGISTRY_INVALID');
    }
  });
});

describe('ViewNextHandler', () => {
  const payload = { version: 1, expectedPlaybackVersion: 3, expectedDesiredSequence: 7 };
  const principal: CommandPrincipal = { deviceId: 42, externalId: 'display-42', credentialId: 'credential-42' };
  const commandId = 'b7c054e1-f0cb-47be-9875-b06e2c468026';
  const event: InteractionEvent = {
    protocolVersion: '1.0', eventId: 'event-42', deviceId: 'display-42',
    credentialId: 'credential-42', publicationId: 'publication-42', revision: '2',
    action: 'view.next', targetId: 'next-button', payload, occurredAt: '2026-09-02T10:00:00.000Z',
  };
  const tx = {} as Prisma.TransactionClient;

  function setup() {
    const result = { playbackId: 'playback-42', version: 4, playlistRevisionId: 'playlist-revision-42',
      status: 'running', currentItemId: 2, nextTransitionAt: null, desiredSequence: 8 };
    const executeInTransaction = mock(async (_tx: Prisma.TransactionClient, _deviceId: number, _body: unknown) => result);
    const handler = new ViewNextHandler({ executeInTransaction } as unknown as PlaybackService);
    return { handler, executeInTransaction, result };
  }

  test('advertises only view.next version 1.0 and accepts positive safe-integer fences', () => {
    const { handler, executeInTransaction } = setup();
    expect(handler.action).toBe('view.next');
    expect(handler.payloadSchemaVersion).toBe('1.0');
    for (const value of [1, 3, Number.MAX_SAFE_INTEGER]) {
      const input = { version: 1 as const, expectedPlaybackVersion: value, expectedDesiredSequence: value };
      expect(handler.validate(input)).toEqual(input);
    }
    expect(executeInTransaction).not.toHaveBeenCalled();
  });

  test('rejects missing, mistyped and unsupported payload versions', () => {
    const { handler, executeInTransaction } = setup();
    const { version: _version, ...missing } = payload;
    for (const input of [missing, ...[0, 2, '1', null, true].map(version => ({ ...payload, version }))]) {
      expect(() => handler.validate(input)).toThrow(BadRequestException);
      expect(() => handler.validate(input)).toThrow('INTERACTION_INVALID_PAYLOAD');
    }
    expect(executeInTransaction).not.toHaveBeenCalled();
  });

  test('requires both fences and rejects non-positive, fractional and unsafe values', () => {
    const { handler, executeInTransaction } = setup();
    for (const key of ['expectedPlaybackVersion', 'expectedDesiredSequence']) {
      const missing: JsonObject = { ...payload };
      delete missing[key];
      expect(() => handler.validate(missing)).toThrow('INTERACTION_INVALID_PAYLOAD');
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '3', null, true, [], {}]) {
        expect(() => handler.validate({ ...payload, [key]: value })).toThrow('INTERACTION_INVALID_PAYLOAD');
      }
    }
    expect(executeInTransaction).not.toHaveBeenCalled();
  });

  test('rejects unknown keys instead of accepting alternate commands or device identities', () => {
    const { handler, executeInTransaction } = setup();
    const extras: JsonObject[] = [{ action: 'stop' }, { deviceId: 99 }, { idempotencyKey: commandId },
      { playlistRevisionId: 'other-playlist' }, { ignoredMetadata: {} }];
    for (const extra of extras) {
      expect(() => handler.validate({ ...payload, ...extra })).toThrow('INTERACTION_INVALID_PAYLOAD');
    }
    expect(executeInTransaction).not.toHaveBeenCalled();
  });

  test('delegates a complete command in the same transaction using the authenticated principal', async () => {
    const { handler, executeInTransaction, result } = setup();
    const input = handler.validate(payload);
    const response = await handler.execute(tx, principal, input,
      { ...event, deviceId: 'not-the-principal', credentialId: 'not-the-credential', payload: { version: 99 } }, commandId);
    expect(executeInTransaction).toHaveBeenCalledTimes(1);
    expect(executeInTransaction).toHaveBeenCalledWith(tx, principal.deviceId, {
      version: 1, idempotencyKey: commandId, action: 'advance',
      expectedVersion: input.expectedPlaybackVersion, expectedDesiredSequence: input.expectedDesiredSequence,
    });
    expect(executeInTransaction.mock.calls[0][0]).toBe(tx);
    expect(response).toEqual({ stateRevision: '4', result });
    expect(payload).toEqual({ version: 1, expectedPlaybackVersion: 3, expectedDesiredSequence: 7 });
  });

  test('propagates domain conflicts so the caller can roll back its savepoint', async () => {
    const conflict = new ConflictException('Playback or desired sequence conflict');
    const executeInTransaction = mock(async () => { throw conflict; });
    const handler = new ViewNextHandler({ executeInTransaction } as unknown as PlaybackService);
    await expect(handler.execute(tx, principal, handler.validate(payload), event, commandId)).rejects.toBe(conflict);
    expect(executeInTransaction).toHaveBeenCalledTimes(1);
  });
});
