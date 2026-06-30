export const VECTOR_METADATA_KEYS = new Set([
  "embedding",
  "embedding_vector",
  "vector",
  "query_vector",
]);

export type StableMetadataTextOptions = {
  metadataKeys?: "all" | readonly string[] | false;
  assignment?: ":" | "=";
  entrySeparator?: string;
  maxDepth?: number;
  maxEntries?: number;
  maxArrayItems?: number;
  maxValueChars?: number;
  maxTextChars?: number;
};

type MetadataEntry = {
  key: string;
  value: string;
};

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 96;
const DEFAULT_MAX_ARRAY_ITEMS = 48;
const DEFAULT_MAX_VALUE_CHARS = 320;
const DEFAULT_MAX_TEXT_CHARS = 12_000;

function normalizePrimitive(value: string | number | boolean, maxValueChars: number): string | null {
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return null;
  return normalized.length > maxValueChars ? normalized.slice(0, maxValueChars) : normalized;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAllowedDescendant(path: string, allowedKeys: Set<string> | null): boolean {
  if (!allowedKeys) return true;
  for (const key of allowedKeys) {
    if (key === path || key.startsWith(`${path}.`)) return true;
  }
  return false;
}

function collectMetadataEntries(
  value: unknown,
  path: string,
  topKeyAllowed: boolean,
  allowedKeys: Set<string> | null,
  entries: MetadataEntry[],
  options: Required<Pick<StableMetadataTextOptions, "maxDepth" | "maxEntries" | "maxArrayItems" | "maxValueChars">>,
  depth: number,
): void {
  if (entries.length >= options.maxEntries) return;
  if (!topKeyAllowed && allowedKeys && !hasAllowedDescendant(path, allowedKeys)) return;

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (!topKeyAllowed && allowedKeys && !allowedKeys.has(path)) return;
    const normalized = normalizePrimitive(value, options.maxValueChars);
    if (normalized !== null) entries.push({ key: path, value: normalized });
    return;
  }

  if (depth >= options.maxDepth || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, options.maxArrayItems)) {
      if (entries.length >= options.maxEntries) return;
      collectMetadataEntries(item, path, topKeyAllowed, allowedKeys, entries, options, depth + 1);
    }
    return;
  }

  if (!isJsonRecord(value)) return;

  for (const [key, child] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (entries.length >= options.maxEntries) return;
    if (VECTOR_METADATA_KEYS.has(key)) continue;
    collectMetadataEntries(child, `${path}.${key}`, topKeyAllowed, allowedKeys, entries, options, depth + 1);
  }
}

export function stableMetadataText(
  metadata: Record<string, unknown> | undefined,
  options: StableMetadataTextOptions = {},
): string | null {
  if (!metadata) return null;
  if (options.metadataKeys === false) return null;

  const allowedKeys = Array.isArray(options.metadataKeys) ? new Set(options.metadataKeys) : null;
  const collectOptions = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxArrayItems: options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS,
    maxValueChars: options.maxValueChars ?? DEFAULT_MAX_VALUE_CHARS,
  };
  const entries: MetadataEntry[] = [];

  for (const [key, value] of Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))) {
    if (entries.length >= collectOptions.maxEntries) break;
    if (VECTOR_METADATA_KEYS.has(key)) continue;
    const topKeyAllowed = !allowedKeys || allowedKeys.has(key);
    if (!topKeyAllowed && !hasAllowedDescendant(key, allowedKeys)) continue;
    collectMetadataEntries(value, key, topKeyAllowed, allowedKeys, entries, collectOptions, 0);
  }

  if (entries.length === 0) return null;
  const assignment = options.assignment ?? ":";
  const entrySeparator = options.entrySeparator ?? " ";
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const text = entries
    .sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value))
    .map((entry) => `${entry.key}${assignment}${entry.value}`)
    .join(entrySeparator);
  return text.length > maxTextChars ? text.slice(0, maxTextChars) : text;
}
