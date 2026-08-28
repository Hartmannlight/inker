import { BadRequestException, Injectable } from '@nestjs/common';
import { parseTimerCreatePayload, parseTimerMutationPayload, type JsonObject, type JsonValue } from '@inker/contracts';
import type { Prisma } from '@prisma/client';
import type { CommandHandler, CommandPrincipal } from '../interactions/command-registry';
import { TimerService, type TimerCommandAction } from './timer.service';

export const TIMER_ACTIONS = ['timer.create', 'timer.pause', 'timer.resume', 'timer.cancel', 'timer.acknowledge'] as const;
export class TimerCommandHandler implements CommandHandler {
  readonly payloadSchemaVersion = '1.0' as const;
  constructor(readonly action: typeof TIMER_ACTIONS[number], private readonly timers: TimerService) {}
  validate(payload: JsonObject) {
    const parsed = this.action === 'timer.create' ? parseTimerCreatePayload(payload) : parseTimerMutationPayload(payload);
    if (!parsed.success) throw new BadRequestException('TIMER_INVALID_PAYLOAD');
    return parsed.data;
  }
  async execute(tx: Prisma.TransactionClient, principal: CommandPrincipal, payload: unknown) {
    const result = await this.timers.executeInTransaction(tx, principal, this.action.slice('timer.'.length) as TimerCommandAction, payload);
    return { stateRevision: String(result.version), result: result as unknown as JsonValue };
  }
}
@Injectable()
export class TimerHandlers {
  readonly handlers: CommandHandler[];
  constructor(timers: TimerService) { this.handlers = TIMER_ACTIONS.map(action => new TimerCommandHandler(action, timers)); }
}
