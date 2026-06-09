export type MangaSource = "otruyen" | "mangadex";

export const MANGADEX_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const OTRUYEN_OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

const UUID_HEX_RE = /^[0-9a-f]{32}$/i;
const OTRUYEN_ROUTE_PREFIX = "07e0aa";
const OTRUYEN_ROUTE_VERSION_POS = 12;
const OTRUYEN_ROUTE_VARIANT_POS = 16;
const OTRUYEN_ROUTE_VERSION = "5";
const OTRUYEN_ROUTE_VARIANT = "8";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanRouteToken(value?: string | null): string {
  return safeDecode(String(value || "")).trim();
}

function stripUuidHyphens(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

function isOTruyenFixedRoutePos(pos: number): boolean {
  return (
    pos < OTRUYEN_ROUTE_PREFIX.length ||
    pos === OTRUYEN_ROUTE_VERSION_POS ||
    pos === OTRUYEN_ROUTE_VARIANT_POS
  );
}

function hyphenateUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeOTruyenObjectId(value?: string | null): string | null {
  const normalized = cleanRouteToken(value).toLowerCase();
  if (!normalized) return null;

  const compact = stripUuidHyphens(normalized);
  if (OTRUYEN_OBJECT_ID_RE.test(compact)) return compact;
  if (!UUID_HEX_RE.test(compact)) return null;
  if (!compact.startsWith(OTRUYEN_ROUTE_PREFIX)) return null;
  if (compact[OTRUYEN_ROUTE_VERSION_POS] !== OTRUYEN_ROUTE_VERSION) return null;
  if (compact[OTRUYEN_ROUTE_VARIANT_POS] !== OTRUYEN_ROUTE_VARIANT) return null;

  let objectId = "";
  for (let pos = 0; pos < compact.length; pos += 1) {
    if (!isOTruyenFixedRoutePos(pos)) {
      objectId += compact[pos];
    }
  }

  return OTRUYEN_OBJECT_ID_RE.test(objectId) ? objectId : null;
}

export function toOTruyenRouteId(value?: string | null): string | null {
  const objectId = normalizeOTruyenObjectId(value);
  if (!objectId) return null;

  let sourceIndex = 0;
  let routeHex = "";
  for (let pos = 0; pos < 32; pos += 1) {
    if (pos < OTRUYEN_ROUTE_PREFIX.length) {
      routeHex += OTRUYEN_ROUTE_PREFIX[pos];
    } else if (pos === OTRUYEN_ROUTE_VERSION_POS) {
      routeHex += OTRUYEN_ROUTE_VERSION;
    } else if (pos === OTRUYEN_ROUTE_VARIANT_POS) {
      routeHex += OTRUYEN_ROUTE_VARIANT;
    } else {
      routeHex += objectId[sourceIndex] || "0";
      sourceIndex += 1;
    }
  }

  return hyphenateUuid(routeHex);
}

export function isOTruyenRouteId(value?: string | null): boolean {
  const raw = cleanRouteToken(value);
  return !!raw && !!normalizeOTruyenObjectId(raw) && raw.includes("-");
}

export function normalizeMangaDexId(value?: string | null): string | null {
  let normalized = cleanRouteToken(value).toLowerCase();
  if (normalized.startsWith("mdx-")) {
    normalized = normalized.slice(4);
  }
  if (normalized.startsWith("mangadex-")) {
    normalized = normalized.slice("mangadex-".length);
  }
  if (isOTruyenRouteId(normalized)) return null;
  return MANGADEX_ID_RE.test(normalized) ? normalized : null;
}

function normalizeSource(value?: string | null): MangaSource | null {
  const normalized = cleanRouteToken(value).toLowerCase();
  if (normalized === "otruyen" || normalized === "mangadex") {
    return normalized;
  }
  return null;
}

export function getMangaSource(
  identifier?: string | null,
  source?: string | null,
): MangaSource {
  const explicitSource = normalizeSource(source);
  if (explicitSource) return explicitSource;
  if (normalizeOTruyenObjectId(identifier)) return "otruyen";
  return normalizeMangaDexId(identifier) ? "mangadex" : "otruyen";
}

export function getMangaDetailPath(
  identifier?: string | null,
  source?: string | null,
): string {
  const rawIdentifier = cleanRouteToken(identifier);
  if (!rawIdentifier) return "/manga";

  const resolvedSource = getMangaSource(rawIdentifier, source);
  const routeIdentifier =
    resolvedSource === "mangadex"
      ? normalizeMangaDexId(rawIdentifier) || rawIdentifier
      : toOTruyenRouteId(rawIdentifier) || rawIdentifier;

  return `/manga/${encodeURIComponent(routeIdentifier)}`;
}

export function resolveMangaRoute(
  sourceParam?: string | null,
  idParam?: string | null,
) {
  const routeSource = normalizeSource(sourceParam);
  const rawIdentifier = routeSource
    ? cleanRouteToken(idParam)
    : cleanRouteToken(idParam || sourceParam);
  const source = routeSource || getMangaSource(rawIdentifier);
  const identifier =
    source === "mangadex"
      ? normalizeMangaDexId(rawIdentifier) || rawIdentifier
      : normalizeOTruyenObjectId(rawIdentifier) || rawIdentifier;
  const canonicalPath = getMangaDetailPath(identifier, source);
  const currentPath = rawIdentifier
    ? `/manga/${encodeURIComponent(rawIdentifier)}`
    : "/manga";

  return {
    source,
    identifier,
    canonicalPath,
    isCanonical: !routeSource && currentPath === canonicalPath,
  };
}
