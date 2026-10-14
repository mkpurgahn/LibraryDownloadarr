export const READER_POLICY = 'epub-scroll-v1';
export const ASSET_BUDGET = 64 * 1024 * 1024;
export function resourceReference(value: string): { id: string; fragment?: string } | undefined {
  const match = /^book-resource:([a-f0-9]{64})(?:#([^?#\s]{1,3000}))?$/.exec(value);
  if (!match) return undefined;
  try { return { id: match[1], ...(match[2] ? { fragment: decodeURIComponent(match[2]) } : {}) }; }
  catch { return undefined; }
}
