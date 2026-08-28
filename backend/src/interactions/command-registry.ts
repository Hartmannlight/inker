import type { InteractionEvent, JsonObject, JsonValue } from '@inker/contracts';
import type { Prisma } from '@prisma/client';

export type CommandPrincipal = { deviceId: number; externalId: string; credentialId: string };
export type HandlerResult = { stateRevision?: string; result?: JsonValue };
export interface CommandHandler {
  readonly action: string;
  readonly payloadSchemaVersion: '1.0';
  validate(payload: JsonObject): unknown;
  execute(tx: Prisma.TransactionClient, principal: CommandPrincipal, payload: unknown,
    event: InteractionEvent, commandId: string): Promise<HandlerResult>;
}

/** The controller has no widget/action switch; domain modules supply handlers. */
export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();
  constructor(handlers: readonly CommandHandler[]) {
    if (handlers.length > 32) throw new Error('COMMAND_REGISTRY_LIMIT');
    for (const handler of handlers) {
      if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(handler.action)
        || handler.action.length > 64 || handler.payloadSchemaVersion !== '1.0'
        || this.handlers.has(handler.action)) throw new Error('COMMAND_REGISTRY_INVALID');
      this.handlers.set(handler.action, handler);
    }
  }
  get(action: string) { return this.handlers.get(action); }
}
