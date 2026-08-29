/** Existing device identifiers plus the complete base64url enrollment alphabet. */
export function isDeviceIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || /[^A-Za-z0-9._:-]/.test(value)) return false;
  // Preserve legacy namespaced IDs; leading '-'/'_' are valid in generated IDs.
  return /^[A-Za-z0-9]/.test(value) || /^[A-Za-z0-9_-]+$/.test(value);
}
