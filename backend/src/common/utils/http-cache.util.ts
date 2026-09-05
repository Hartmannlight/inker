/** RFC 9110 sections 5.6.1.2 / 13.1.2: weak comparison and recipient list grammar. */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const tagPattern = /(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/y;
  let offset = 0;
  let matched = false;
  const skipWhitespace = () => {
    while (header[offset] === ' ' || header[offset] === '\t') offset++;
  };
  while (offset < header.length) {
    skipWhitespace();
    if (offset === header.length) break;
    if (header[offset] === ',') {
      offset++;
      continue;
    }
    tagPattern.lastIndex = offset;
    const tag = tagPattern.exec(header);
    if (!tag) return false;
    matched ||= tag[0].replace(/^W\//, '') === etag.replace(/^W\//, '');
    offset = tagPattern.lastIndex;
    skipWhitespace();
    if (offset < header.length && header[offset] !== ',') return false;
    if (header[offset] === ',') offset++;
  }
  return matched;
}
