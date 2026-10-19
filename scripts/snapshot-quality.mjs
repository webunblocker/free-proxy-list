import { isIP } from "node:net";

export const SNAPSHOT_SCOPE = "verified-working";
export const MAX_CHECK_AGE_HOURS = 2;

export function endpointKey(row) {
  return `${row?.ip}:${row?.port}`;
}

export function isVerifiedWorking(row, at) {
  const checked = Date.parse(row?.last_checked ?? "");
  const age = Date.parse(at) - checked;
  return Number.isFinite(checked) && Number.isFinite(age) && age >= -60_000 &&
    age <= MAX_CHECK_AGE_HOURS * 3_600_000 &&
    Number.isFinite(row?.health_score) && row.health_score > 0;
}

export function assertSnapshotRecords(records, timestamp) {
  if (!Array.isArray(records) || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("Snapshot records and timestamp are required");
  }
  const keys = new Set();
  for (const row of records) {
    if (isIP(row.ip) !== 4 || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535) {
      throw new Error("Snapshot contains an invalid endpoint");
    }
    if (!/^[A-Z]{2}$/.test(row.country_code)) throw new Error("Snapshot country group must be a two-letter code or ZZ");
    if (!isVerifiedWorking(row, timestamp)) throw new Error(`Snapshot contains an unchecked, failed or stale row: ${endpointKey(row)}`);
    const key = endpointKey(row);
    if (keys.has(key)) throw new Error(`Duplicate endpoint in snapshot: ${key}`);
    keys.add(key);
  }
  // A genuinely empty successful response is valid. Never fill it with old,
  // failed or untested rows to satisfy a quantity/country floor.
}

/** Read one stable API pagination snapshot, or fail without publishing a partial set. */
export async function fetchWorkingSnapshot({ apiBaseUrl, apiKey = "", fetchImpl = fetch, timeoutMs = 30_000 }) {
  const endpoint = apiKey ? "/api/v1/proxies" : "/api/proxies";
  const records = [];
  let expected = null;
  for (let offset = 0; expected === null || offset < expected;) {
    const url = new URL(endpoint, apiBaseUrl);
    url.search = new URLSearchParams({ working_only: "true", limit: "100", offset: String(offset), sort: "health" }).toString();
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "Socks5Proxies-VerifiedSnapshot/2.0", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Snapshot API returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.data) || !Number.isInteger(payload?.meta?.total) || payload.meta.total < 0) {
      throw new Error("Snapshot API returned an invalid data/total shape");
    }
    if (expected === null) expected = payload.meta.total;
    if (payload.meta.total !== expected) throw new Error("Snapshot changed during pagination; retry a fresh collection");
    if (payload.data.length === 0 && offset < expected) throw new Error("Snapshot pagination ended before its total");
    records.push(...payload.data);
    offset += payload.data.length;
    if (offset > expected) throw new Error("Snapshot API returned more rows than its total");
  }
  if (new Set(records.map(endpointKey)).size !== records.length) throw new Error("Snapshot changed during pagination: duplicate endpoints");
  return records;
}

export function serializeSnapshotCsv(rows) {
  const columns = ["ip", "port", "country_code", "country_name", "protocols", "anonymity_level", "anonymity_tested", "reported_anonymity_level", "uptime", "delay", "last_checked", "health_score"];
  const escape = (value) => `"${String(Array.isArray(value) ? value.join("|") : value ?? "").replace(/"/g, '""')}"`;
  return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n") + "\n";
}
