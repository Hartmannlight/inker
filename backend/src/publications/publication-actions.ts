import { types } from 'node:util';
import type { AllowedAction } from '@inker/contracts';

const actionPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const targetPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Pure validation/projection; syntactically valid future actions grant no handler. */
export function normalizePublicationActions(input: unknown): AllowedAction[] {
  const invalid = (): never => { throw new Error('PUBLICATION_ACTIONS_INVALID'); };
  if (input === undefined) return [];
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length > 16 || Reflect.ownKeys(input).length !== input.length + 1) return invalid();
  const result: AllowedAction[] = [], pairs = new Set<string>();
  const entries = Object.getOwnPropertyDescriptors(input);
  for (let index = 0; index < input.length; index++) {
    const entry = entries[index];
    if (!entry?.enumerable || !('value' in entry)) return invalid();
    const value = entry.value;
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).some(key => typeof key !== 'string'
      || !['action', 'targetId', 'payloadSchemaVersion'].includes(key)
      || !fields[key].enumerable || !('value' in fields[key]))) return invalid();
    const action = fields.action?.value, targetId = fields.targetId?.value;
    if (typeof action !== 'string' || action.length > 64 || !actionPattern.test(action)
      || fields.payloadSchemaVersion?.value !== '1.0'
      || (targetId !== undefined && (typeof targetId !== 'string' || !targetPattern.test(targetId)))) return invalid();
    const pair = action + '\0' + (targetId ?? '');
    if (pairs.has(pair)) return invalid();
    pairs.add(pair);
    result.push({ action, ...(targetId !== undefined ? { targetId } : {}), payloadSchemaVersion: '1.0' });
  }
  return result.sort((a, b) => {
    const left = a.action + '\0' + (a.targetId ?? ''), right = b.action + '\0' + (b.targetId ?? '');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
