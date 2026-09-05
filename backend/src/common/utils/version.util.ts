/**
 * Compare dotted numeric versions with an optional leading `v` and optional
 * prerelease/build suffix. Malformed or missing values never signal an update.
 */
export function isNewerVersion(
  candidate?: string | null,
  current?: string | null,
): boolean {
  const parse = (value?: string | null): number[] | null => {
    if (!value) return null;
    const normalized = value.trim();
    if (!/^v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/i.test(normalized)) {
      return null;
    }
    return normalized
      .replace(/^v/i, '')
      .split(/[-+]/, 1)[0]
      .split('.')
      .map(Number);
  };

  const next = parse(candidate);
  const baseline = parse(current);
  if (!next || !baseline) return false;

  const length = Math.max(next.length, baseline.length);
  for (let index = 0; index < length; index++) {
    const nextPart = next[index] ?? 0;
    const baselinePart = baseline[index] ?? 0;
    if (nextPart > baselinePart) return true;
    if (nextPart < baselinePart) return false;
  }
  return false;
}
