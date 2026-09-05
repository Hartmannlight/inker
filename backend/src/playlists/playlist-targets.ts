export type PlaylistTargetKind = 'design' | 'regular' | 'plugin';

export interface PlaylistTargetInput {
  screenId: string | number;
  duration?: number | null;
  order?: number;
}

export interface ParsedPlaylistTarget {
  kind: PlaylistTargetKind;
  id: number;
  order: number;
  duration: number | null;
  source: string;
}

export interface ParsedPlaylistTargets {
  targets: ParsedPlaylistTarget[];
  designIds: number[];
  regularIds: number[];
  pluginIds: number[];
  invalid: string[];
}

export interface PlaylistTargetExistence {
  designIds: ReadonlySet<number>;
  regularIds: ReadonlySet<number>;
  pluginIds: ReadonlySet<number>;
}

export type PlaylistItemCreate = {
  playlistId: number;
  order: number;
  duration: number | null;
  screenId?: number;
  screenDesignId?: number;
  pluginInstanceId?: number;
};

const MAX_DATABASE_ID = 2_147_483_647;

function parseDatabaseId(value: string | number): number | null {
  const parsed = typeof value === 'number'
    ? value
    : /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_DATABASE_ID ? parsed : null;
}

export function parsePlaylistTargets(inputs: readonly PlaylistTargetInput[]): ParsedPlaylistTargets {
  const result: ParsedPlaylistTargets = {
    targets: [],
    designIds: [],
    regularIds: [],
    pluginIds: [],
    invalid: [],
  };

  inputs.forEach((input, index) => {
    const source = String(input.screenId);
    const prefixed = typeof input.screenId === 'string'
      ? /^(design|plugin)-(.+)$/.exec(input.screenId)
      : null;
    const kind: PlaylistTargetKind = prefixed?.[1] === 'design'
      ? 'design'
      : prefixed?.[1] === 'plugin' ? 'plugin' : 'regular';
    const rawId = prefixed ? prefixed[2] : input.screenId;
    const id = parseDatabaseId(rawId);
    if (id === null) {
      result.invalid.push(source);
      return;
    }

    const target: ParsedPlaylistTarget = {
      kind,
      id,
      order: input.order ?? index,
      duration: input.duration === 0 || input.duration === null ? null : input.duration ?? 60,
      source,
    };
    result.targets.push(target);
    if (kind === 'design') result.designIds.push(id);
    else if (kind === 'plugin') result.pluginIds.push(id);
    else result.regularIds.push(id);
  });

  return result;
}

export function materializePlaylistItems(
  playlistId: number,
  parsed: ParsedPlaylistTargets,
  existing: PlaylistTargetExistence,
): { items: PlaylistItemCreate[]; missing: ParsedPlaylistTarget[] } {
  const items: PlaylistItemCreate[] = [];
  const missing: ParsedPlaylistTarget[] = [];

  for (const target of parsed.targets) {
    const exists = target.kind === 'design'
      ? existing.designIds.has(target.id)
      : target.kind === 'plugin'
        ? existing.pluginIds.has(target.id)
        : existing.regularIds.has(target.id);
    if (!exists) {
      missing.push(target);
      continue;
    }

    const base = { playlistId, order: target.order, duration: target.duration };
    items.push(target.kind === 'design'
      ? { ...base, screenDesignId: target.id }
      : target.kind === 'plugin'
        ? { ...base, pluginInstanceId: target.id }
        : { ...base, screenId: target.id });
  }

  return { items, missing };
}
