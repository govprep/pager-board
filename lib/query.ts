/** Quote a PostgREST filter value without letting it change filter structure. */
export function filterLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function keysetFilter(before: string, column: "id" | "hash", key: string): string {
  const time = filterLiteral(before);
  return `received_at.lt.${time},and(received_at.eq.${time},${column}.lt.${filterLiteral(key)})`;
}

export function incidentFilter(search?: string, before?: string, beforeId?: string): string | undefined {
  const term = (search ?? "").trim().replace(/[%_\\]/g, "\\$&");
  const searchFilter = term
    ? ["incident_no", "type", "unit", "location", "raw"]
      .map((column) => `${column}.ilike.${filterLiteral(`%${term}%`)}`).join(",")
    : undefined;
  const cursor = before && beforeId ? keysetFilter(before, "id", beforeId) : undefined;
  return searchFilter && cursor ? `and(or(${searchFilter}),or(${cursor}))` : searchFilter ?? cursor;
}

export function readPagination(params: URLSearchParams, keyName: "beforeId" | "beforeHash") {
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 200 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const before = params.get("before") ?? undefined;
  const key = params.get(keyName) ?? undefined;
  // Preserve fractional seconds: converting to a JS Date would lose the database's microseconds.
  if (before !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(before) || !Number.isFinite(Date.parse(before)))) {
    throw new Error("before must be an ISO timestamp");
  }
  if (key !== undefined && (!before || !key || key.length > 512 || /[\x00-\x1f]/.test(key))) {
    throw new Error(`${keyName} requires a timestamp and a valid cursor`);
  }
  if (keyName === "beforeHash" && key !== undefined && !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error("beforeHash must be a SHA-256 hash");
  }
  const q = params.get("q")?.trim() || undefined;
  if (q && q.length > 256) throw new Error("Search is limited to 256 characters");
  return { limit: Math.min(limit, 500), before, key, q };
}

export function validateLines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500 || !value.every((line) => typeof line === "string" && line.length <= 8192)) {
    throw new Error("Provide up to 500 messages, each at most 8192 characters");
  }
  return value.map((line: string) => line.trim()).filter(Boolean);
}
