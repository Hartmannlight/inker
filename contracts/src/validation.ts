export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: ValidationSeverity;
}

export type ParseResult<T> =
  | { success: true; data: T; warnings: ValidationIssue[] }
  | { success: false; errors: ValidationIssue[]; warnings: ValidationIssue[] };

export interface ValidationContext {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export type ContractValidator<T> = (
  value: unknown,
  context: ValidationContext,
  path: string,
) => value is T;

export function parseContract<T>(value: unknown, validator: ContractValidator<T>): ParseResult<T> {
  const context: ValidationContext = { errors: [], warnings: [] };
  const valid = validator(value, context, '$');
  if (!valid || context.errors.length > 0) {
    return { success: false, errors: context.errors, warnings: context.warnings };
  }
  return { success: true, data: value, warnings: context.warnings };
}

export function addIssue(
  context: ValidationContext,
  severity: ValidationSeverity,
  code: string,
  path: string,
  message: string,
): void {
  context[severity === 'error' ? 'errors' : 'warnings'].push({
    code,
    path,
    message,
    severity,
  });
}

export function asRecord(
  value: unknown,
  context: ValidationContext,
  path: string,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    addIssue(context, 'error', 'expected_object', path, 'Expected a JSON object.');
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  record: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  path: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    addIssue(context, 'error', 'expected_non_empty_string', `${path}.${key}`, 'Expected a non-empty string.');
    return undefined;
  }
  return value;
}

export function optionalString(
  record: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    addIssue(context, 'error', 'expected_non_empty_string', `${path}.${key}`, 'Expected a non-empty string when provided.');
    return undefined;
  }
  return value;
}

export function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  path: string,
): boolean | undefined {
  const value = record[key];
  if (typeof value !== 'boolean') {
    addIssue(context, 'error', 'expected_boolean', `${path}.${key}`, 'Expected a boolean.');
    return undefined;
  }
  return value;
}

export function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  path: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    addIssue(context, 'error', 'expected_boolean', `${path}.${key}`, 'Expected a boolean when provided.');
    return undefined;
  }
  return value;
}

export function requiredInteger(
  record: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  path: string,
  options: { minimum?: number; maximum?: number } = {},
): number | undefined {
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    (options.minimum !== undefined && value < options.minimum) ||
    (options.maximum !== undefined && value > options.maximum)
  ) {
    const bounds = [
      options.minimum === undefined ? undefined : `>= ${options.minimum}`,
      options.maximum === undefined ? undefined : `<= ${options.maximum}`,
    ].filter(Boolean).join(' and ');
    addIssue(
      context,
      'error',
      'expected_integer',
      `${path}.${key}`,
      `Expected an integer${bounds ? ` ${bounds}` : ''}.`,
    );
    return undefined;
  }
  return value;
}

export function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  path: string,
  options: { minimum?: number; maximum?: number } = {},
): number | undefined {
  if (record[key] === undefined) return undefined;
  return requiredInteger(record, key, context, path, options);
}

export function requiredEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  context: ValidationContext,
  path: string,
): T | undefined {
  const value = record[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    addIssue(
      context,
      'error',
      'unsupported_value',
      `${path}.${key}`,
      `Expected one of: ${allowed.join(', ')}.`,
    );
    return undefined;
  }
  return value as T;
}

export function requiredEnumArray<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  context: ValidationContext,
  path: string,
  options: { allowEmpty?: boolean } = {},
): T[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    addIssue(context, 'error', 'expected_array', `${path}.${key}`, 'Expected a non-empty array.');
    return undefined;
  }
  let valid = true;
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !allowed.includes(item as T)) {
      valid = false;
      addIssue(
        context,
        'error',
        'unsupported_value',
        `${path}.${key}[${index}]`,
        `Expected one of: ${allowed.join(', ')}.`,
      );
    }
  });
  return valid ? value as T[] : undefined;
}

export function requiredStringArray(
  record: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  path: string,
): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(context, 'error', 'expected_array', `${path}.${key}`, 'Expected a non-empty string array.');
    return undefined;
  }
  let valid = true;
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      valid = false;
      addIssue(context, 'error', 'expected_non_empty_string', `${path}.${key}[${index}]`, 'Expected a non-empty string.');
    }
  });
  return valid ? value as string[] : undefined;
}

export function validateIsoTimestamp(
  record: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  path: string,
  optional = false,
): string | undefined {
  const value = record[key];
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) {
    addIssue(context, 'error', 'invalid_timestamp', `${path}.${key}`, 'Expected an ISO-8601 timestamp with a timezone.');
    return undefined;
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    addIssue(context, 'error', 'timestamp_timezone_required', `${path}.${key}`, 'Timestamp must include Z or an explicit UTC offset.');
    return undefined;
  }
  return value;
}
