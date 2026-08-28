import { describe, expect, test } from 'bun:test';
import type { PublicationRevision } from '@prisma/client';
import { normalizePublicationActions } from './publication-actions';
import { canonicalJson, publicationAllowedActions, sha256 } from './publication-content';

const action = (name = 'view.next', targetId?: string) => ({
  action: name, ...(targetId !== undefined ? { targetId } : {}), payloadSchemaVersion: '1.0',
});
function revision(content: any, overrides: Record<string, unknown> = {}): PublicationRevision {
  return { publicationRevisionId: 'revision-1', publicationId: 'publication-1', revision: 1,
    protocolVersion: '1.0', content, contentHash: sha256(canonicalJson(content)), publishedAt: new Date(), ...overrides } as PublicationRevision;
}
const content = (allowedActions: any) => ({ schemaVersion: 1, fixtureArtifacts: ['mono-800x480-white-bmp'], allowedActions });

describe('explicit publication action rights', () => {
  test('absence and empty lists grant no rights', () => {
    expect(normalizePublicationActions(undefined)).toEqual([]);
    expect(normalizePublicationActions([])).toEqual([]);
  });

  test('projects independent values and sorts future actions and distinct targets canonically', () => {
    const input = [action('view.next', 'z'), action('future.handler'), action('view.next'), action('view.next', 'a')];
    const output = normalizePublicationActions(input);
    expect(output).toEqual([action('future.handler'), action('view.next'), action('view.next', 'a'), action('view.next', 'z')]);
    input[0].action = 'changed.value';
    expect(output[3].action).toBe('view.next');
  });

  test('bounds list size, action grammar and opaque target IDs', () => {
    const maximum = Array.from({ length: 16 }, (_, index) => action('view.next', 'target-' + index));
    expect(normalizePublicationActions(maximum)).toHaveLength(16);
    expect(() => normalizePublicationActions([...maximum, action('view.next', 'seventeen')])).toThrow('PUBLICATION_ACTIONS_INVALID');
    expect(normalizePublicationActions([action('a.' + 'b'.repeat(62), 'A'.repeat(128))])).toHaveLength(1);
    for (const name of ['', 'view', 'View.next', '.view.next', 'view.', 'view..next', 'view.next_action', 'view.next-action', 'a.' + 'b'.repeat(63), 'view.next\n']) {
      expect(() => normalizePublicationActions([action(name)])).toThrow('PUBLICATION_ACTIONS_INVALID');
    }
    for (const target of ['', ' ', '../file', '/run/secrets', 'https://host', 'a'.repeat(129), '_private', '\nsecret']) {
      expect(() => normalizePublicationActions([action('view.next', target)])).toThrow('PUBLICATION_ACTIONS_INVALID');
    }
  });

  test('rejects duplicates, unknown fields, wrong schema and non-data inputs', () => {
    for (const input of [
      null, {}, 'view.next', [null], [42], [action(), action()],
      [{ ...action(), targetId: null }], [{ ...action(), payloadSchemaVersion: '1.1' }],
      [{ action: 'view.next' }], [{ ...action(), payload: {} }], [{ ...action(), authorization: 'sentinel' }],
      [{ ...action(), [Symbol('extra')]: true }],
      [Object.create(action())], new Array(1),
    ]) expect(() => normalizePublicationActions(input)).toThrow('PUBLICATION_ACTIONS_INVALID');
    let called = false;
    expect(() => normalizePublicationActions([{ get action() { called = true; return 'view.next'; }, payloadSchemaVersion: '1.0' }])).toThrow();
    expect(() => normalizePublicationActions(new Proxy([], { get() { called = true; return 1; } }))).toThrow();
    expect(called).toBe(false);
  });

  test('only valid hashed publications project rights; legacy or invalid content fails closed', () => {
    const valid = revision(content([action('view.next', 'playlist-1')]));
    expect(publicationAllowedActions(valid)).toEqual([action('view.next', 'playlist-1')]);
    const projected = publicationAllowedActions(valid);
    projected[0].action = 'changed.value';
    expect(publicationAllowedActions(valid)).toEqual([action('view.next', 'playlist-1')]);
    for (const invalid of [
      revision({ fixtureArtifacts: ['mono-800x480-white-bmp'], allowedActions: [action()] }),
      revision({ schemaVersion: 1, fixtureArtifacts: ['mono-800x480-white-bmp'] }),
      revision(content([action()]), { contentHash: 'tampered' }),
      revision(content([action()]), { protocolVersion: '2.0' }),
      revision({ ...content([action()]), schemaVersion: 2 }),
      revision({ ...content([action()]), fixtureArtifacts: ['unknown'] }),
      revision(content([action(), action()])),
      revision(content([{ ...action(), secret: 'sentinel' }])),
      revision(content([{ ...action(), payloadSchemaVersion: '2.0' }])),
      revision(null),
    ]) expect(publicationAllowedActions(invalid)).toEqual([]);
  });
});
