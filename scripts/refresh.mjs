#!/usr/bin/env node

import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scaffoldRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.outputDir ?? scaffoldRoot);

const config = {
  apiBaseUrl: stripTrailingSlash(
    process.env.API_BASE_URL ?? "https://api.socks5proxies.com",
  ),
  apiKey: (process.env.PROXYLIST_API_KEY ?? process.env.API_KEY ?? "").trim(),
  siteUrl: stripTrailingSlash(
    process.env.SITE_URL ?? "https://socks5proxies.com",
  ),
  repoSlug: process.env.REPO_SLUG ?? "socks5proxies/free-proxy-list",
  repoBranch: process.env.REPO_BRANCH ?? "main",
  fetchTimeoutMs: 60_000,
  exportLimit: 100_000,
  pageSize: 100,
  userAgent:
    "Socks5Proxies-FreeProxyList-Refresh/1.0 (+https://socks5proxies.com)",
};

const downloadBaseUrl =
  process.env.DOWNLOAD_BASE_URL ??
  `https://cdn.jsdelivr.net/gh/${config.repoSlug}@${config.repoBranch}`;

const protocolOrder = ["http", "https", "socks4", "socks5"];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  console.log(`Refreshing proxy snapshot into ${outputDir}`);

  const stats = await loadStats();
  const allPayload = await loadAllPayload();
  const allRecords = parseRecords(allPayload).map(normalizeRecord);
  const protocolGroups = buildProtocolGroups(allRecords);
  const countryGroups = buildCountryGroups(allRecords);
  const protocols = new Map(
    protocolOrder.map((protocol) => [protocol, protocolGroups[protocol].length]),
  );
  const countries = new Map(
    [...countryGroups.entries()].map(([countryCode, records]) => [
      countryCode,
      records.length,
    ]),
  );

  const totalAll = allRecords.length;
  if (!Number.isFinite(totalAll) || totalAll <= 0) {
    throw new Error("Proxy stats returned zero live proxies");
  }

  const timestamp =
    stats?.meta?.last_sync ||
    new Date().toISOString();

  const filteredCountries = [...countries.entries()]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  await rm(path.join(outputDir, "proxies"), { recursive: true, force: true });

  await writeGroupFiles("all", allRecords, outputDir);

  for (const protocol of protocolOrder) {
    await writeGroupFiles(
      path.join("protocols", protocol),
      protocolGroups[protocol],
      outputDir,
    );
  }

  for (const [countryCode, records] of filteredCountries.map(([countryCode]) => [
    countryCode,
    countryGroups.get(countryCode) ?? [],
  ])) {
    await writeGroupFiles(
      path.join("countries", countryCode),
      records,
      outputDir,
    );
  }

  const meta = {
    timestamp,
    source: {
      api_base: config.apiBaseUrl,
      site_url: config.siteUrl,
    },
    totals: {
      all: totalAll,
      protocols: Object.fromEntries(
        protocolOrder.map((protocol) => [protocol, protocols.get(protocol) ?? 0]),
      ),
      countries: Object.fromEntries(filteredCountries),
    },
    downloads: {
      all: buildDownloadLinks("all"),
      protocols: Object.fromEntries(
        protocolOrder.map((protocol) => [
          protocol,
          buildDownloadLinks(path.join("protocols", protocol)),
        ]),
      ),
      countries: Object.fromEntries(
        filteredCountries.map(([countryCode]) => [
          countryCode,
          buildDownloadLinks(path.join("countries", countryCode)),
        ]),
      ),
    },
    generated_by: {
      script: "scripts/refresh.mjs",
      repo_slug: config.repoSlug,
      repo_branch: config.repoBranch,
    },
  };

  await writeJson(path.join(outputDir, "proxies", "meta", "data.json"), meta);

  const readme = await renderReadme({
    timestamp,
    totalAll,
    protocols,
    countries: filteredCountries,
  });
  await writeText(path.join(outputDir, "README.md"), readme);

  console.log(
    `Refresh complete: ${totalAll} proxies across ${filteredCountries.length} countries`,
  );
  console.log(`All downloads: ${buildDownloadLinks("all").txt}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--output-dir") {
      parsed.outputDir = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

async function fetchJson(endpoint) {
  const response = await fetchResponse(endpoint);
  return response.json();
}

async function loadStats() {
  try {
    return await fetchJson("/api/proxies/stats");
  } catch (error) {
    const cachedMeta = await readJsonIfExists(
      path.join(outputDir, "proxies", "meta", "data.json"),
    );
    if (cachedMeta?.timestamp) {
      console.warn(
        `Stats request failed, falling back to cached timestamp: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return { meta: { last_sync: cachedMeta.timestamp } };
    }
    throw error;
  }
}

async function loadAllPayload() {
  if (config.apiKey) {
    try {
      return await fetchAllViaAuthenticatedList();
    } catch (error) {
      console.warn(
        `Authenticated pagination failed, falling back to export endpoint: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  try {
    return await fetchJson(`/api/proxies/export/json?limit=${config.exportLimit}`);
  } catch (error) {
    const cachedPayload = await readJsonIfExists(
      path.join(outputDir, "proxies", "all", "data.json"),
    );
    if (cachedPayload) {
      console.warn(
        `Export request failed, falling back to cached all/data.json: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return cachedPayload;
    }
    throw error;
  }
}

async function fetchResponse(endpoint) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${config.apiBaseUrl}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": config.userAgent,
      accept: "*/*",
      ...(config.apiKey
        ? {
            authorization: `Bearer ${config.apiKey}`,
          }
        : {}),
    },
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response;
}

async function fetchAllViaAuthenticatedList() {
  const records = [];
  let offset = 0;
  let total = Infinity;

  while (records.length < total && records.length < config.exportLimit) {
    const searchParams = new URLSearchParams();
    searchParams.set("limit", String(config.pageSize));
    searchParams.set("offset", String(offset));
    const payload = await fetchJson(`/api/v1/proxies?${searchParams}`);
    const page = parseRecords(payload);
    const metaTotal = Number(payload?.meta?.total ?? page.length);

    if (!Number.isFinite(metaTotal) || metaTotal < 0) {
      throw new Error("Authenticated list response did not include a valid total");
    }

    total = Math.min(metaTotal, config.exportLimit);
    if (page.length === 0) {
      break;
    }

    records.push(...page);
    offset += page.length;

    if (page.length < config.pageSize) {
      break;
    }
  }

  if (records.length === 0) {
    throw new Error("Authenticated list pagination returned zero records");
  }

  return { data: records.slice(0, config.exportLimit) };
}

function parseRecords(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  return [];
}

function normalizeRecord(record) {
  const countryCode = String(record.country_code || "").trim().toUpperCase() || "ZZ";
  const countryName = String(record.country_name || "").trim() || "Unknown";
  return {
    ...record,
    country_code: countryCode,
    country_name: countryName,
  };
}

function buildProtocolGroups(records) {
  return {
    http: records.filter((record) => Boolean(record.http)),
    https: records.filter((record) => Boolean(record.ssl)),
    socks4: records.filter((record) => Boolean(record.socks4)),
    socks5: records.filter((record) => Boolean(record.socks5)),
  };
}

function buildCountryGroups(records) {
  const groups = new Map();
  for (const record of records) {
    const countryCode = record.country_code;
    const existing = groups.get(countryCode) ?? [];
    existing.push(record);
    groups.set(countryCode, existing);
  }
  return groups;
}

async function writeGroupFiles(groupPath, records, rootDir) {
  if (!Array.isArray(records)) {
    throw new Error(`Invalid record payload for ${groupPath}`);
  }

  await writeText(
    path.join(rootDir, "proxies", groupPath, "data.json"),
    `${JSON.stringify({ data: records }, null, 2)}\n`,
  );
  await writeText(
    path.join(rootDir, "proxies", groupPath, "data.txt"),
    serializeTxt(records),
  );
  await writeText(
    path.join(rootDir, "proxies", groupPath, "data.csv"),
    serializeCsv(records),
  );
}

function buildDownloadLinks(groupPath) {
  const safePath = groupPath.split(path.sep).join("/");
  return {
    json: `${downloadBaseUrl}/proxies/${safePath}/data.json`,
    txt: `${downloadBaseUrl}/proxies/${safePath}/data.txt`,
    csv: `${downloadBaseUrl}/proxies/${safePath}/data.csv`,
  };
}

async function renderReadme({ timestamp, totalAll, protocols, countries }) {
  const templatePath = path.join(scaffoldRoot, "templates", "README.md.tmpl");
  const template = await readFile(templatePath, "utf8");
  const usCount = countries.find(([code]) => code === "US")?.[1] ?? 0;
  const updatedAt = formatTimestamp(timestamp);

  const replacements = {
    SITE_URL: config.siteUrl,
    REPO_SLUG: config.repoSlug,
    REPO_BRANCH: config.repoBranch,
    PROXY_LIST_URL: buildSiteUrl("/free-proxy-list", "repo_readme"),
    BULK_CHECKER_URL: buildSiteUrl("/tools/bulk-checker", "repo_readme"),
    API_DOCS_URL: buildSiteUrl("/docs/api", "repo_readme"),
    UPDATED_AT: updatedAt,
    TOTAL_ALL: String(totalAll),
    TOTAL_HTTP: String(protocols.get("http") ?? 0),
    TOTAL_HTTPS: String(protocols.get("https") ?? 0),
    TOTAL_SOCKS4: String(protocols.get("socks4") ?? 0),
    TOTAL_SOCKS5: String(protocols.get("socks5") ?? 0),
    COUNTRY_COUNT: String(countries.length),
    ALL_JSON_URL: buildDownloadLinks("all").json,
    ALL_TXT_URL: buildDownloadLinks("all").txt,
    ALL_CSV_URL: buildDownloadLinks("all").csv,
    HTTP_JSON_URL: buildDownloadLinks(path.join("protocols", "http")).json,
    HTTP_TXT_URL: buildDownloadLinks(path.join("protocols", "http")).txt,
    HTTP_CSV_URL: buildDownloadLinks(path.join("protocols", "http")).csv,
    HTTPS_JSON_URL: buildDownloadLinks(path.join("protocols", "https")).json,
    HTTPS_TXT_URL: buildDownloadLinks(path.join("protocols", "https")).txt,
    HTTPS_CSV_URL: buildDownloadLinks(path.join("protocols", "https")).csv,
    SOCKS4_JSON_URL: buildDownloadLinks(path.join("protocols", "socks4")).json,
    SOCKS4_TXT_URL: buildDownloadLinks(path.join("protocols", "socks4")).txt,
    SOCKS4_CSV_URL: buildDownloadLinks(path.join("protocols", "socks4")).csv,
    SOCKS5_JSON_URL: buildDownloadLinks(path.join("protocols", "socks5")).json,
    SOCKS5_TXT_URL: buildDownloadLinks(path.join("protocols", "socks5")).txt,
    SOCKS5_CSV_URL: buildDownloadLinks(path.join("protocols", "socks5")).csv,
    US_JSON_URL: buildDownloadLinks(path.join("countries", "US")).json,
    US_TXT_URL: buildDownloadLinks(path.join("countries", "US")).txt,
    US_CSV_URL: buildDownloadLinks(path.join("countries", "US")).csv,
    US_ROW:
      usCount > 0
        ? `| US Proxies | ${usCount} | [data.json](${buildDownloadLinks(path.join("countries", "US")).json}) | [data.txt](${buildDownloadLinks(path.join("countries", "US")).txt}) | [data.csv](${buildDownloadLinks(path.join("countries", "US")).csv}) |`
        : "",
  };

  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => replacements[key] ?? "");
}

function buildSiteUrl(pathname, medium) {
  const url = new URL(pathname, `${config.siteUrl}/`);
  url.searchParams.set("utm_source", "github");
  url.searchParams.set("utm_medium", medium);
  url.searchParams.set("utm_campaign", "free_proxy_list_repo");
  return url.toString();
}

function formatTimestamp(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

async function readJsonIfExists(filePath) {
  try {
    const value = await readFile(filePath, "utf8");
    return JSON.parse(value);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function serializeTxt(records) {
  return `${records.map((record) => `${record.ip}:${record.port}`).join("\n")}\n`;
}

function serializeCsv(records) {
  const header = [
    "ip",
    "port",
    "country_code",
    "country_name",
    "city",
    "region",
    "asn",
    "asn_name",
    "org",
    "protocols",
    "anonymity",
    "uptime",
    "delay_ms",
    "last_seen",
  ];

  const rows = records.map((record) => [
    record.ip,
    String(record.port ?? ""),
    record.country_code ?? "",
    record.country_name ?? "",
    record.city ?? "",
    record.region ?? "",
    record.asn ? String(record.asn) : "",
    record.asn_name ?? "",
    record.org ?? "",
    Array.isArray(record.protocols) ? record.protocols.join("|") : "",
    record.anonymity_level ?? "",
    String(record.uptime ?? ""),
    String(record.delay ?? ""),
    record.last_seen ?? "",
  ]);

  return `${[header, ...rows].map(toCsvRow).join("\n")}\n`;
}

function toCsvRow(columns) {
  return columns
    .map((column) => {
      const value = String(column ?? "");
      if (/[",\n]/.test(value)) {
        return `"${value.replace(/"/g, "\"\"")}"`;
      }
      return value;
    })
    .join(",");
}
