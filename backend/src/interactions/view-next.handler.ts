import { BadRequestException, Injectable } from '@nestjs/common';
import type { InteractionEvent, JsonObject } from '@inker/contracts';
import type { Prisma } from '@prisma/client';
import { PlaybackService } from '../playback/playback.service';
import type { CommandHandler, CommandPrincipal } from './command-registry';

type Payload = { version: 1; expectedPlaybackVersion: number; expectedDesiredSequence: number };
@Injectable()
export class ViewNextHandler implements CommandHandler {
  readonly action = 'view.next';
  readonly payloadSchemaVersion = '1.0' as const;
  constructor(private readonly playback: PlaybackService) {}
  validate(payload: JsonObject): Payload {
    if (Object.keys(payload).some(key => !['version', 'expectedPlaybackVersion', 'expectedDesiredSequence'].includes(key))
      || payload.version !== 1 || !Number.isSafeInteger(payload.expectedPlaybackVersion)
      || Number(payload.expectedPlaybackVersion) < 1 || !Number.isSafeInteger(payload.expectedDesiredSequence)
      || Number(payload.expectedDesiredSequence) < 1) throw new BadRequestException('INTERACTION_INVALID_PAYLOAD');
    return payload as Payload;
  }
  async execute(tx: Prisma.TransactionClient, principal: CommandPrincipal, payload: Payload, _event: InteractionEvent, commandId: string) {
    const result = await this.playback.executeInTransaction(tx, principal.deviceId, {
      version: 1, idempotencyKey: commandId, action: 'advance', expectedVersion: payload.expectedPlaybackVersion,
      expectedDesiredSequence: payload.expectedDesiredSequence,
    });
    return { stateRevision: String(result.version), result };
  }
}
