import axios from 'axios';
import type { JsonValue } from '@inker/contracts';
import { createSafeHttpAgent, createSafeHttpsAgent, validateUrlSafety } from '../common/utils/url-safety';
import type { ConnectorContext, ConnectorResult } from './connectors';

export interface HttpConnectorConfiguration {
  url: string;
  format: 'json' | 'rss';
  method: 'GET' | 'POST';
  jsonPath?: string;
  allowLocalNetwork: boolean;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/;
const BLOCKED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization']);

function fail(code: string): never { throw new Error(code); }

export function validateHttpConnectorConfiguration(value: unknown): HttpConnectorConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SOURCE_CONNECTOR_INVALID_CONFIG');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['url', 'format', 'method', 'jsonPath', 'allowLocalNetwork'].includes(key))
    || typeof input.url !== 'string' || input.url.length > 2048
    || !['json', 'rss'].includes(String(input.format))
    || !['GET', 'POST'].includes(String(input.method))
    || typeof input.allowLocalNetwork !== 'boolean'
    || input.jsonPath !== undefined && (typeof input.jsonPath !== 'string' || input.jsonPath.length > 500)) {
    fail('SOURCE_CONNECTOR_INVALID_CONFIG');
  }
  let parsed: URL;
  try { parsed = new URL(input.url); } catch { return fail('SOURCE_CONNECTOR_INVALID_CONFIG'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    fail('SOURCE_CONNECTOR_INVALID_CONFIG');
  }
  return {
    url: parsed.toString(), format: input.format as 'json' | 'rss', method: input.method as 'GET' | 'POST',
    allowLocalNetwork: input.allowLocalNetwork,
    ...(input.jsonPath ? { jsonPath: input.jsonPath as string } : {}),
  };
}

function parseHeaders(secret?: string): Record<string, string> {
  if (!secret) return {};
  let value: unknown;
  try { value = JSON.parse(secret); } catch { return fail('HTTP_HEADERS_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32) {
    fail('HTTP_HEADERS_INVALID');
  }
  const headers: Record<string, string> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (!HEADER_NAME.test(name) || BLOCKED_HEADERS.has(name.toLowerCase()) || typeof item !== 'string' || item.length > 4096
      || /[\r\n]/.test(item)) fail('HTTP_HEADERS_INVALID');
    headers[name] = item;
  }
  return headers;
}

function extractPath(value: unknown, path?: string): unknown {
  if (!path || path === '$') return value;
  const normalized = path.replace(/^\$\.?/, '');
  if (!normalized || !/^[A-Za-z0-9_.[\]*-]+$/.test(normalized)) fail('HTTP_JSON_PATH_INVALID');
  const parts = normalized.split(/\.|\[|\]/).filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (part === '*') {
      if (!Array.isArray(current)) fail('HTTP_JSON_PATH_INVALID');
      continue;
    }
    if (Array.isArray(current)) {
      if (/^\d+$/.test(part)) current = current[Number(part)];
      else current = current.map(item => item && typeof item === 'object' ? (item as Record<string, unknown>)[part] : null);
    } else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[part];
    else fail('HTTP_JSON_PATH_INVALID');
  }
  if (current === undefined) fail('HTTP_JSON_PATH_INVALID');
  return current;
}

function decodeXml(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function element(xml: string, names: string): string | undefined {
  const match = xml.match(new RegExp(`<(?:${names})(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:${names})>`, 'i'));
  return match ? decodeXml(match[1]) : undefined;
}

function parseFeed(xml: string): JsonValue {
  if (xml.length > MAX_RESPONSE_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) fail('HTTP_FEED_INVALID');
  const items: Array<Record<string, JsonValue>> = [];
  const expression = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>|<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(xml)) && items.length < 100) {
    const body = match[1] || match[2];
    const linkAttribute = body.match(/<link(?:\s[^>]*)?\shref=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1];
    const item: Record<string, JsonValue> = {};
    for (const [key, names] of [['title', 'title'], ['description', 'description|summary|content'],
      ['link', 'link'], ['pubDate', 'pubDate|published|updated']] as const) {
      const found = key === 'link' && linkAttribute ? decodeXml(linkAttribute) : element(body, names);
      if (found !== undefined) item[key] = found.slice(0, key === 'description' ? 2000 : 1000);
    }
    items.push(item);
  }
  return {
    ...(element(xml, 'title') ? { title: element(xml, 'title')! } : {}),
    ...(element(xml, 'description|subtitle') ? { description: element(xml, 'description|subtitle')! } : {}),
    items,
  };
}

function assertNoCredentialEcho(data: unknown, headers: Record<string, string>) {
  const serialized = JSON.stringify(data);
  for (const value of Object.values(headers)) {
    if (value.length >= 4 && serialized.includes(value)) fail('HTTP_CREDENTIAL_ECHO');
  }
}

/** Worker-only HTTP connector. Redirects are disabled and DNS is pinned through
 * the private-network blocking agents to prevent redirect and rebinding SSRF. */
export async function runHttpConnector(configInput: unknown, context: ConnectorContext): Promise<ConnectorResult> {
  const config = validateHttpConnectorConfiguration(configInput);
  const headers = parseHeaders(context.secret);
  try { await validateUrlSafety(config.url, { allowLocalNetwork: config.allowLocalNetwork }); }
  catch { return fail('HTTP_NETWORK_BLOCKED'); }
  try {
    const response = await axios.request<unknown>({
      url: config.url, method: config.method, headers: { Accept: config.format === 'json' ? 'application/json' : 'application/rss+xml, application/atom+xml, text/xml', ...headers },
      responseType: config.format === 'rss' ? 'text' : 'json', timeout: 7_500, maxRedirects: 0,
      maxContentLength: MAX_RESPONSE_BYTES, maxBodyLength: MAX_RESPONSE_BYTES,
      httpAgent: createSafeHttpAgent({ allowLocalNetwork: config.allowLocalNetwork }),
      httpsAgent: createSafeHttpsAgent({ allowLocalNetwork: config.allowLocalNetwork }), signal: context.signal,
      validateStatus: status => status >= 200 && status < 300,
    });
    const data = config.format === 'rss'
      ? parseFeed(String(response.data))
      : extractPath(response.data, config.jsonPath);
    assertNoCredentialEcho(data, headers);
    const date = response.headers['last-modified'] || response.headers.date;
    const sourceTimestamp = typeof date === 'string' && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : undefined;
    return { data: data as JsonValue, connectorVersion: config.format === 'rss' ? 'http-feed-v1' : 'http-json-v1', ...(sourceTimestamp ? { sourceTimestamp } : {}) };
  } catch (error) {
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) throw error;
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) fail('HTTP_AUTH_INVALID');
      if (error.response?.status === 403) fail('HTTP_PERMISSION_DENIED');
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ERR_CANCELED') fail('HTTP_TIMEOUT');
      if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') fail('HTTP_DNS_FAILED');
    }
    fail('HTTP_REQUEST_FAILED');
  }
}
