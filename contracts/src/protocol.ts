import {
  addIssue,
  parseContract,
  type ParseResult,
  type ValidationContext,
} from './validation';

export const CURRENT_PROTOCOL_VERSION = '1.0' as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [CURRENT_PROTOCOL_VERSION] as const;

export type ProtocolVersion = `${number}.${number}`;
export type ProtocolCompatibilityStatus = 'supported' | 'unknown-compatible' | 'incompatible' | 'malformed';

export interface ProtocolCompatibility {
  status: ProtocolCompatibilityStatus;
  version?: ProtocolVersion;
  message: string;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function assessProtocolVersion(value: unknown): ProtocolCompatibility {
  if (typeof value !== 'string') {
    return { status: 'malformed', message: 'Protocol version must be a major.minor string.' };
  }
  const match = VERSION_PATTERN.exec(value);
  if (!match) {
    return { status: 'malformed', message: `Protocol version "${value}" must use major.minor syntax.` };
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [currentMajor, currentMinor] = CURRENT_PROTOCOL_VERSION.split('.').map(Number);
  const version = value as ProtocolVersion;

  if (major !== currentMajor) {
    return {
      status: 'incompatible',
      version,
      message: `Protocol major ${major} is incompatible with supported major ${currentMajor}.`,
    };
  }
  if (minor > currentMinor) {
    return {
      status: 'unknown-compatible',
      version,
      message: `Protocol minor ${minor} is newer than known minor ${currentMinor}; unknown fields and features are ignored.`,
    };
  }
  return { status: 'supported', version, message: `Protocol version ${version} is supported.` };
}

export function validateProtocolVersion(
  value: unknown,
  context: ValidationContext,
  path: string,
): value is ProtocolVersion {
  const compatibility = assessProtocolVersion(value);
  if (compatibility.status === 'malformed' || compatibility.status === 'incompatible') {
    addIssue(context, 'error', `protocol_${compatibility.status}`, path, compatibility.message);
    return false;
  }
  if (compatibility.status === 'unknown-compatible') {
    addIssue(context, 'warning', 'protocol_unknown_minor', path, compatibility.message);
  }
  return true;
}

export function parseProtocolVersion(value: unknown): ParseResult<ProtocolVersion> {
  return parseContract(value, validateProtocolVersion);
}
