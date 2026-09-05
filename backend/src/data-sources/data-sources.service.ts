import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDataSourceDto } from './dto/create-data-source.dto';
import { UpdateDataSourceDto } from './dto/update-data-source.dto';
import { TestUrlDto } from './dto/test-url.dto';
import { wrapPaginatedResponse } from '../common/utils/response.util';
import { SettingsService } from '../settings/settings.service';
import { Prisma } from '@prisma/client';

export const SOURCE_REFRESH_REQUIRES_CONNECTOR = 'SOURCE_REFRESH_REQUIRES_CONNECTOR';
export const SOURCE_SNAPSHOT_UNAVAILABLE = 'SOURCE_SNAPSHOT_UNAVAILABLE';

function unavailable(code: string): never {
  throw new ServiceUnavailableException({ statusCode: 503, error: 'Service Unavailable', code, message: code });
}

/**
 * Field metadata extracted from API response.
 * Used to show users what fields are available before creating a data source.
 */
export interface FieldMeta {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  sample: unknown;
  isImageUrl?: boolean;
  isLink?: boolean;
}

@Injectable()
export class DataSourcesService {
  private readonly logger = new Logger(DataSourcesService.name);

  constructor(
    private prisma: PrismaService,
    _settingsService: SettingsService,
  ) {}

  /**
   * Preserve legacy configuration without provider access in the API process.
   */
  async create(createDataSourceDto: CreateDataSourceDto) {
    const dataSource = await this.prisma.dataSource.create({
      data: {
        name: createDataSourceDto.name,
        description: createDataSourceDto.description,
        type: createDataSourceDto.type,
        url: createDataSourceDto.url,
        method: createDataSourceDto.method || 'GET',
        headers: (createDataSourceDto.headers || undefined) as object | undefined,
        refreshInterval: createDataSourceDto.refreshInterval || 300,
        jsonPath: createDataSourceDto.jsonPath,
        isActive: createDataSourceDto.isActive ?? true,
      },
    });

    this.logger.log(`Data source created: ${dataSource.name}`);

    return { ...dataSource, headers: this.maskSensitiveHeaders(dataSource.headers as Record<string, string> | null) };
  }

  /**
   * Find all data sources with pagination
   */
  async findAll(page = 1, limit = 20, activeOnly = false) {
    const where = activeOnly ? { isActive: true } : {};
    const skip = (page - 1) * limit;

    const [dataSources, total] = await Promise.all([
      this.prisma.dataSource.findMany({
        where,
        include: {
          _count: {
            select: { customWidgets: true },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.dataSource.count({ where }),
    ]);

    const masked = dataSources.map(ds => ({
      ...ds,
      headers: this.maskSensitiveHeaders(ds.headers as Record<string, string> | null),
    }));

    return wrapPaginatedResponse(masked, total, page, limit);
  }

  /**
   * Find one data source by ID
   */
  async findOne(id: number) {
    const dataSource = await this.prisma.dataSource.findUnique({
      where: { id },
      include: {
        customWidgets: true,
      },
    });

    if (!dataSource) {
      throw new NotFoundException('Data source not found');
    }

    return {
      ...dataSource,
      headers: this.maskSensitiveHeaders(dataSource.headers as Record<string, string> | null),
    };
  }

  /**
   * Live URL probes require a registered connector in the worker.
   */
  async testUrl(_dto: TestUrlDto): Promise<never> {
    return unavailable(SOURCE_REFRESH_REQUIRES_CONNECTOR);
  }

  /**
   * Extract all field paths from data with their types and sample values.
   * This helps users understand what fields are available from an API.
   *
   * For arrays, generates paths for ALL indices:
   * - arrayName (the array itself)
   * - arrayName[0], arrayName[1], arrayName[2], etc.
   * - arrayName[0].field (for object arrays)
   */
  extractFieldsWithMeta(data: unknown, prefix = ''): FieldMeta[] {
    const fields: FieldMeta[] = [];

    if (data === null || data === undefined) {
      return fields;
    }

    if (Array.isArray(data)) {
      // For arrays, show ALL indices
      data.forEach((item, index) => {
        const itemPath = prefix ? `${prefix}[${index}]` : `[${index}]`;

        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          // Object in array - add fields from this object
          Object.entries(item as Record<string, unknown>).forEach(
            ([key, value]) => {
              const fullPath = `${itemPath}.${key}`;
              if (
                typeof value === 'object' &&
                value !== null &&
                !Array.isArray(value)
              ) {
                // Nested object inside array item
                fields.push(...this.extractFieldsWithMeta(value, fullPath));
              } else if (Array.isArray(value)) {
                // Nested array inside array item
                fields.push({
                  path: fullPath,
                  type: 'array',
                  sample: `Array(${value.length})`,
                });
                if (value.length > 0) {
                  fields.push(...this.extractFieldsWithMeta(value, fullPath));
                }
              } else {
                // Primitive field in array item
                fields.push(this.createFieldMeta(fullPath, value));
              }
            },
          );
        } else if (Array.isArray(item)) {
          // Nested array
          fields.push({
            path: itemPath,
            type: 'array',
            sample: `Array(${item.length})`,
          });
          fields.push(...this.extractFieldsWithMeta(item, itemPath));
        } else {
          // Primitive value in array
          fields.push(this.createFieldMeta(itemPath, item));
        }
      });
    } else if (typeof data === 'object') {
      const obj = data as Record<string, unknown>;

      // Handle RSS feed structure specially
      if ('items' in obj && Array.isArray(obj.items)) {
        // Add feed-level fields
        if (obj.title) {
          fields.push(this.createFieldMeta('title', obj.title));
        }
        if (obj.description) {
          fields.push(this.createFieldMeta('description', obj.description));
        }
        if (obj.link) {
          fields.push(this.createFieldMeta('link', obj.link));
        }

        // Add items array
        fields.push({
          path: 'items',
          type: 'array',
          sample: `Array(${obj.items.length})`,
        });

        // Add ALL item fields with full paths
        fields.push(...this.extractFieldsWithMeta(obj.items, 'items'));
      } else {
        // Regular object - extract all fields recursively
        Object.entries(obj).forEach(([key, value]) => {
          const path = prefix ? `${prefix}.${key}` : key;

          if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
          ) {
            // Nested object - recurse
            fields.push(...this.extractFieldsWithMeta(value, path));
          } else if (Array.isArray(value)) {
            // Array - add the array path and recurse
            fields.push({
              path,
              type: 'array',
              sample: `Array(${value.length})`,
            });
            if (value.length > 0) {
              fields.push(...this.extractFieldsWithMeta(value, path));
            }
          } else {
            // Primitive value
            fields.push(this.createFieldMeta(path, value));
          }
        });
      }
    }

    return fields;
  }

  /**
   * Create field metadata from a path and value
   */
  private createFieldMeta(path: string, value: unknown): FieldMeta {
    const type = this.getValueType(value);
    const meta: FieldMeta = {
      path,
      type,
      sample: this.truncateSample(value),
    };

    // Detect if string looks like an image URL
    if (type === 'string' && typeof value === 'string') {
      if (this.looksLikeImageUrl(value)) {
        meta.isImageUrl = true;
      } else if (this.looksLikeUrl(value)) {
        meta.isLink = true;
      }
    }

    return meta;
  }

  /**
   * Get the type of a value
   */
  private getValueType(
    value: unknown,
  ): 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'string';
  }

  /**
   * Truncate sample value for display
   */
  private truncateSample(value: unknown): unknown {
    if (typeof value === 'string' && value.length > 100) {
      return value.substring(0, 100) + '...';
    }
    if (Array.isArray(value)) {
      return `Array(${value.length})`;
    }
    if (typeof value === 'object' && value !== null) {
      return '{...}';
    }
    return value;
  }

  /**
   * Check if a string looks like an image URL
   */
  private looksLikeImageUrl(value: string): boolean {
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i;
    const imagePatterns =
      /\/(image|img|photo|picture|media)\//i;

    return (
      imageExtensions.test(value) ||
      (imagePatterns.test(value) && value.startsWith('http'))
    );
  }

  /**
   * Check if a string looks like a URL
   */
  private looksLikeUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
  }

  /**
   * Update data source
   */
  async update(id: number, updateDataSourceDto: UpdateDataSourceDto) {
    const dataSource = await this.prisma.dataSource.findUnique({
      where: { id },
    });

    if (!dataSource) {
      throw new NotFoundException('Data source not found');
    }

    // Preserve original header values when masked values are submitted
    const headers = this.unmaskedHeaders(
      updateDataSourceDto.headers as Record<string, string> | null,
      dataSource.headers as Record<string, string> | null,
    );

    const updatedDataSource = await this.prisma.dataSource.update({
      where: { id },
      data: {
        name: updateDataSourceDto.name,
        description: updateDataSourceDto.description,
        type: updateDataSourceDto.type,
        url: updateDataSourceDto.url,
        method: updateDataSourceDto.method,
        headers: headers ?? Prisma.JsonNull,
        refreshInterval: updateDataSourceDto.refreshInterval,
        jsonPath: updateDataSourceDto.jsonPath,
        isActive: updateDataSourceDto.isActive,
      },
    });

    this.logger.log(`Data source updated: ${updatedDataSource.name}`);

    return { ...updatedDataSource, headers: this.maskSensitiveHeaders(updatedDataSource.headers as Record<string, string> | null) };
  }

  /**
   * Delete data source
   */
  async remove(id: number) {
    const dataSource = await this.prisma.dataSource.findUnique({
      where: { id },
      include: {
        _count: {
          select: { customWidgets: true },
        },
      },
    });

    if (!dataSource) {
      throw new NotFoundException('Data source not found');
    }

    if (dataSource._count.customWidgets > 0) {
      throw new BadRequestException(
        `Cannot delete data source with ${dataSource._count.customWidgets} widget(s) using it`,
      );
    }

    await this.prisma.dataSource.delete({
      where: { id },
    });

    this.logger.log(`Data source deleted: ${dataSource.name}`);

    return { message: 'Data source deleted successfully' };
  }

  /** No arbitrary legacy provider is registered in the Foundation connector set. */
  async testFetch(_id: number): Promise<never> {
    return unavailable(SOURCE_REFRESH_REQUIRES_CONNECTOR);
  }

  async refresh(_id: number): Promise<never> {
    return unavailable(SOURCE_REFRESH_REQUIRES_CONNECTOR);
  }

  async fetchDataFromSource(_dataSource: {
    type: string;
    url: string;
    method: string;
    headers?: object | null;
    jsonPath?: string | null;
  }): Promise<never> {
    return unavailable(SOURCE_REFRESH_REQUIRES_CONNECTOR);
  }

  /**
   * Mask sensitive values in headers to prevent leaking API keys/tokens in responses
   */
  private maskSensitiveHeaders(headers: Record<string, string> | null): Record<string, string> | null {
    if (!headers) return null;
    const sensitiveKeys = ['authorization', 'x-api-key', 'api-key', 'token', 'bearer', 'secret'];
    const masked = { ...headers };
    for (const key of Object.keys(masked)) {
      if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
        const val = masked[key];
        masked[key] = val && val.length > 4 ? val.slice(0, 4) + '••••••••' : '••••••••';
      }
    }
    return masked;
  }

  /**
   * Restore original header values where the submitted value is still masked.
   * If a header value contains '••••••••', it was not changed by the user — keep the DB value.
   */
  private unmaskedHeaders(
    submitted: Record<string, string> | null,
    existing: Record<string, string> | null,
  ): Record<string, string> | null {
    if (!submitted) return submitted;
    if (!existing) return submitted;
    const result = { ...submitted };
    for (const key of Object.keys(result)) {
      if (result[key]?.includes('••••••••') && existing[key]) {
        result[key] = existing[key];
      }
    }
    return result;
  }

  /**
   * Parse RSS/Atom XML to normalized JSON
   */
  private parseRss(xml: string): {
    title?: string;
    description?: string;
    link?: string;
    items: Array<{
      title?: string;
      description?: string;
      link?: string;
      pubDate?: string;
    }>;
  } {
    // Simple RSS/Atom parser without external dependencies
    const result: {
      title?: string;
      description?: string;
      link?: string;
      items: Array<{
        title?: string;
        description?: string;
        link?: string;
        pubDate?: string;
      }>;
    } = { items: [] };

    // Extract channel/feed info
    const titleMatch = xml.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
    if (titleMatch) {
      result.title = this.cleanXmlText(titleMatch[1]);
    }

    const descMatch = xml.match(/<description[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/i);
    if (descMatch) {
      result.description = this.cleanXmlText(descMatch[1]);
    }

    // Extract items (RSS) or entries (Atom)
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const itemContent = itemMatch[1] || itemMatch[2];
      const item: {
        title?: string;
        description?: string;
        link?: string;
        pubDate?: string;
      } = {};

      // Title
      const itemTitle = itemContent.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
      if (itemTitle) {
        item.title = this.cleanXmlText(itemTitle[1]);
      }

      // Description/Summary/Content
      const itemDesc = itemContent.match(
        /<(?:description|summary|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content)>/i,
      );
      if (itemDesc) {
        item.description = this.cleanXmlText(itemDesc[1]).substring(0, 500);
      }

      // Link
      const itemLink = itemContent.match(/<link[^>]*>([^<]*)<\/link>|<link[^>]*href=["']([^"']+)["']/i);
      if (itemLink) {
        item.link = itemLink[1] || itemLink[2];
      }

      // Publication date
      const itemDate = itemContent.match(
        /<(?:pubDate|published|updated)[^>]*>([^<]*)<\/(?:pubDate|published|updated)>/i,
      );
      if (itemDate) {
        item.pubDate = itemDate[1];
      }

      result.items.push(item);
    }

    return result;
  }

  /**
   * Clean XML text content
   */
  private cleanXmlText(text: string): string {
    return text
      .replace(/<[^>]+>/g, '') // Remove HTML tags
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract data using JSONPath-like syntax
   * Supports: $.field, $.nested.field, $.array[0], $.array[*].field
   */
  private extractWithJsonPath(data: unknown, path: string): unknown {
    if (!path || path === '$') {
      return data;
    }

    // Remove leading $. if present
    const cleanPath = path.replace(/^\$\.?/, '');
    const parts = cleanPath.split(/\.|\[|\]/).filter(Boolean);

    let current: unknown = data;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return null;
      }

      if (part === '*' && Array.isArray(current)) {
        // Wildcard for arrays - return all items
        return current;
      }

      if (Array.isArray(current)) {
        const index = parseInt(part, 10);
        if (!isNaN(index)) {
          current = current[index];
        } else {
          // Map over array to extract field from each item
          current = current.map((item) =>
            typeof item === 'object' && item !== null
              ? (item as Record<string, unknown>)[part]
              : undefined,
          );
        }
      } else if (typeof current === 'object' && current !== null) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return null;
      }
    }

    return current;
  }

  /**
   * Legacy compatibility read: never refresh, modify status or load credentials.
   * The optional argument remains source-compatible; all reads now skip fetch.
   */
  async getCachedData(id: number, _skipFetch = false): Promise<unknown> {
    const dataSource = await this.prisma.dataSource.findUnique({
      where: { id },
      select: { lastData: true },
    });

    if (!dataSource) {
      throw new NotFoundException('Data source not found');
    }

    if (dataSource.lastData === null || dataSource.lastData === undefined) return unavailable(SOURCE_SNAPSHOT_UNAVAILABLE);
    return dataSource.lastData;
  }
}
