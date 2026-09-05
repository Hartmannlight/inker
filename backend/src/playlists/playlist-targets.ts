export type PlaylistTargetKind = 'design' | 'regular' | 'plugin' | 'recipe';

export interface PlaylistTargetInput {
  screenId: string | number;
  duration?: number | null;
  order?: number;
}

export interface ParsedPlaylistTarget {
  kind: PlaylistTargetKind;
  id: number | string;
  order: number;
  duration: number | null;
  source: string;
}

export interface ParsedPlaylistTargets {
  targets: ParsedPlaylistTarget[];
  designIds: number[];
  regularIds: number[];
  pluginIds: number[];
  recipeIds: string[];
  invalid: string[];
}

export interface PlaylistTargetExistence {
  designIds: ReadonlySet<number>;
  regularIds: ReadonlySet<number>;
  pluginIds: ReadonlySet<number>;
  recipeIds: ReadonlySet<string>;
}

export type PlaylistItemCreate = {
  playlistId: number;
  order: number;
  duration: number | null;
  screenId?: number;
  screenDesignId?: number;
  pluginInstanceId?: number;
  recipeBindingId?: string;
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
    recipeIds: [],
    invalid: [],
  };

  inputs.forEach((input, index) => {
    const source = String(input.screenId);
    const recipe = typeof input.screenId === 'string' ? /^recipe:(.+)$/.exec(input.screenId) : null;
    const prefixed = !recipe && typeof input.screenId === 'string'
      ? /^(design|plugin)-(.+)$/.exec(input.screenId)
      : null;
    const kind: PlaylistTargetKind = recipe ? 'recipe' : prefixed?.[1] === 'design'
      ? 'design'
      : prefixed?.[1] === 'plugin' ? 'plugin' : 'regular';
    const rawId = recipe ? recipe[1] : prefixed ? prefixed[2] : input.screenId;
    const id = kind === 'recipe'
      ? (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(rawId)) ? String(rawId) : null)
      : parseDatabaseId(rawId);
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
    if (kind === 'design') result.designIds.push(Number(id));
    else if (kind === 'plugin') result.pluginIds.push(Number(id));
    else if (kind === 'recipe') result.recipeIds.push(String(id));
    else result.regularIds.push(Number(id));
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
      ? existing.designIds.has(Number(target.id))
      : target.kind === 'plugin'
        ? existing.pluginIds.has(Number(target.id))
        : target.kind === 'recipe'
          ? existing.recipeIds.has(String(target.id))
          : existing.regularIds.has(Number(target.id));
    if (!exists) {
      missing.push(target);
      continue;
    }

    const base = { playlistId, order: target.order, duration: target.duration };
    items.push(target.kind === 'design'
      ? { ...base, screenDesignId: Number(target.id) }
      : target.kind === 'plugin'
        ? { ...base, pluginInstanceId: Number(target.id) }
        : target.kind === 'recipe'
          ? { ...base, recipeBindingId: String(target.id) }
          : { ...base, screenId: Number(target.id) });
  }

  return { items, missing };
}
