import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { canonicalJson, sha256 } from '../common/utils/content-hash.util';
import type { ConnectorType } from '../sources/connectors';

export type RecipeLayout = 'full' | 'halfHorizontal' | 'halfVertical' | 'quadrant';
export type RecipeLayouts = Record<RecipeLayout, string | null>;
export type RecipeSetting = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'timezone';
  required: boolean;
  default?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
};
export type PreparedRecipeManifest = {
  protocolVersion: '1.0';
  slug: string;
  name: string;
  description: string | null;
  source: string;
  sourceUrl: string | null;
  license: string | null;
  layouts: RecipeLayouts;
  partials: Record<string, string>;
  settingsSchema: RecipeSetting[];
  requiredConnectorType: ConnectorType | null;
  contentHash: string;
};

const connectorTypes = new Set<ConnectorType>(['fixture', 'slow', 'failure', 'grafana', 'http-json', 'http-feed']);
const settingTypes = new Set<RecipeSetting['type']>(['text', 'number', 'boolean', 'select', 'timezone']);
const partialName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const staticPartial = /\{%-?\s*(?:render|include)\s+['"]([A-Za-z0-9][A-Za-z0-9_-]{0,63})['"]\s*-?%\}/g;

function invalid(): never { throw new BadRequestException('RECIPE_MANIFEST_INVALID'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, optional = false): string | null {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) return invalid();
  return value.trim();
}

function parseSettings(value: unknown): RecipeSetting[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) return invalid();
  const seen = new Set<string>();
  return value.map(item => {
    const input = record(item);
    if (Object.keys(input).some(key => !['key', 'label', 'type', 'required', 'default', 'options'].includes(key))
      || typeof input.key !== 'string' || !partialName.test(input.key) || seen.has(input.key)
      || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120
      || !settingTypes.has(input.type as RecipeSetting['type'])
      || input.required !== undefined && typeof input.required !== 'boolean'
      || input.default !== undefined && !['string', 'number', 'boolean'].includes(typeof input.default)) return invalid();
    seen.add(input.key);
    let options: RecipeSetting['options'];
    if (input.options !== undefined) {
      if (input.type !== 'select' || !Array.isArray(input.options) || !input.options.length || input.options.length > 100) return invalid();
      options = input.options.map(option => {
        const entry = record(option);
        if (Object.keys(entry).some(key => !['label', 'value'].includes(key)) || typeof entry.label !== 'string'
          || typeof entry.value !== 'string' || !entry.label || entry.label.length > 120 || entry.value.length > 500) return invalid();
        return { label: entry.label, value: entry.value };
      });
    }
    return {
      key: input.key, label: input.label.trim(), type: input.type as RecipeSetting['type'], required: input.required === true,
      ...(input.default !== undefined ? { default: input.default as string | number | boolean } : {}), ...(options ? { options } : {}),
    };
  });
}

function parsePartials(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const input = record(value);
  if (Object.keys(input).length > 32) return invalid();
  const partials: Record<string, string> = {};
  for (const [name, markup] of Object.entries(input)) {
    if (!partialName.test(name) || typeof markup !== 'string' || markup.length > 64 * 1024) return invalid();
    partials[name] = markup;
  }
  return partials;
}

/** Resolve only literal, argument-free partials. Dynamic paths, parameters,
 * layouts and recursion remain hard failures instead of gaining guest IO. */
export function compileRecipeMarkup(markup: string, partials: Record<string, string>, ancestors: string[] = []): string {
  if (typeof markup !== 'string' || markup.length > 128 * 1024 || /\{%-?\s*layout\b|\|\s*where_exp\b/i.test(markup)) return invalid();
  const compiled = markup.replace(staticPartial, (_tag, name: string) => {
    if (!(name in partials) || ancestors.includes(name) || ancestors.length >= 8) return invalid();
    return compileRecipeMarkup(partials[name], partials, [...ancestors, name]);
  });
  if (/\{%-?\s*(?:render|include|layout)\b/i.test(compiled) || Buffer.byteLength(compiled) > 128 * 1024) return invalid();
  return compiled;
}

export function prepareRecipeManifest(value: unknown): PreparedRecipeManifest {
  const input = record(value);
  if (Object.keys(input).some(key => !['protocolVersion', 'slug', 'name', 'description', 'source', 'sourceUrl', 'license', 'layouts', 'partials', 'settingsSchema', 'requiredConnectorType'].includes(key))
    || input.protocolVersion !== '1.0' || typeof input.slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.slug)) return invalid();
  const layoutsInput = record(input.layouts);
  if (Object.keys(layoutsInput).some(key => !['full', 'halfHorizontal', 'halfVertical', 'quadrant'].includes(key))
    || typeof layoutsInput.full !== 'string' || !layoutsInput.full) return invalid();
  const partials = parsePartials(input.partials);
  const layouts = Object.fromEntries((['full', 'halfHorizontal', 'halfVertical', 'quadrant'] as const).map(key => {
    const markup = layoutsInput[key];
    if (markup === undefined || markup === null || markup === '') return [key, null];
    if (typeof markup !== 'string') return invalid();
    return [key, compileRecipeMarkup(markup, partials)];
  })) as RecipeLayouts;
  const required = input.requiredConnectorType === undefined || input.requiredConnectorType === null
    ? null : input.requiredConnectorType;
  if (required !== null && !connectorTypes.has(required as ConnectorType)) return invalid();
  const manifest = {
    protocolVersion: '1.0' as const, slug: input.slug, name: text(input.name, 120)!,
    description: text(input.description, 1000, true), source: text(input.source ?? 'inker', 40)!,
    sourceUrl: text(input.sourceUrl, 2048, true), license: text(input.license, 120, true),
    layouts, partials, settingsSchema: parseSettings(input.settingsSchema), requiredConnectorType: required as ConnectorType | null,
  };
  return { ...manifest, contentHash: sha256(canonicalJson(manifest)) };
}

export function validateRecipeSettings(schemaValue: Prisma.JsonValue, value: unknown): Prisma.InputJsonObject {
  const schema = parseSettings(schemaValue);
  const input = value === undefined ? {} : record(value);
  if (Object.keys(input).some(key => !schema.some(field => field.key === key))) return invalid();
  const result: Record<string, string | number | boolean> = {};
  for (const field of schema) {
    const candidate = input[field.key] ?? field.default;
    if (candidate === undefined || candidate === null || candidate === '') {
      if (field.required) return invalid();
      continue;
    }
    if (field.type === 'number' && typeof candidate !== 'number' || field.type === 'boolean' && typeof candidate !== 'boolean'
      || !['number', 'boolean'].includes(field.type) && typeof candidate !== 'string') return invalid();
    if (field.type === 'select' && !field.options?.some(option => option.value === candidate)) return invalid();
    if (typeof candidate === 'string' && candidate.length > 2000) return invalid();
    result[field.key] = candidate as string | number | boolean;
  }
  return result as Prisma.InputJsonObject;
}
