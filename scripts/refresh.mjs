#!/usr/bin/env node

import { access, readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_SCOPE, MAX_CHECK_AGE_HOURS, assertSnapshotRecords, fetchWorkingSnapshot, isVerifiedWorking, serializeSnapshotCsv } from "./snapshot-quality.mjs";

const scaffoldRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-dir");
const outputDir = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : scaffoldRoot);
const apiBaseUrl = (process.env.API_BASE_URL ?? "https://api.socks5proxies.com").replace(/\/+$/, "");
const siteUrl = (process.env.SITE_URL ?? "https://socks5proxies.com").replace(/\/+$/, "");
const apiKey = (process.env.PROXYLIST_API_KEY ?? process.env.API_KEY ?? "").trim();
const repoSlug = process.env.REPO_SLUG ?? "webunblocker/free-proxy-list";
const repoBranch = process.env.REPO_BRANCH ?? "main";
const downloadBase = process.env.DOWNLOAD_BASE_URL ?? `https://cdn.jsdelivr.net/gh/${repoSlug}@${repoBranch}`;
const protocols = ["http", "https", "socks4", "socks5"];
const protocolColumn = { http: "http", https: "ssl", socks4: "socks4", socks5: "socks5" };

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  if (args.includes("--readme-only")) {
    const meta = JSON.parse(await readFile(path.join(outputDir, "proxies/meta/data.json"), "utf8"));
    const payload = JSON.parse(await readFile(path.join(outputDir, "proxies/all/data.json"), "utf8"));
    if (meta.scope !== SNAPSHOT_SCOPE) throw new Error("Existing snapshot is not verified-working; refresh before rendering its README");
    assertSnapshotRecords(payload.data, meta.timestamp);
    await writeText("README.md", await renderReadme(meta));
    return;
  }

  // No stale-cache or unbounded export fallback. A failed/partial collection must
  // leave the previous snapshot unchanged, never give it a fresh timestamp.
  let fetched;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fetched = await fetchWorkingSnapshot({ apiBaseUrl, apiKey });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      console.warn(`Collection attempt ${attempt + 1} failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
    }
  }
  const timestamp = new Date().toISOString();
  const records = fetched.filter((row) => isVerifiedWorking(row, timestamp)).map((row) => ({
    ...row,
    country_code: /^[A-Z]{2}$/.test(String(row.country_code ?? "").toUpperCase()) ? row.country_code.toUpperCase() : "ZZ",
    country_name: String(row.country_name || "Unknown"),
    anonymity_level: row.anonymity_tested === true ? row.anonymity_level : "Unknown",
    anonymity_tested: row.anonymity_tested === true,
    reported_anonymity_level: row.reported_anonymity_level ?? row.anonymity_level ?? "Unknown",
  }));
  assertSnapshotRecords(records, timestamp);
  const countries = new Map();
  for (const row of records) {
    const group = countries.get(row.country_code) ?? [];
    group.push(row);
    countries.set(row.country_code, group);
  }
  const groups = new Map([["all", records]]);
  for (const protocol of protocols) groups.set(`protocols/${protocol}`, records.filter((row) => row[protocolColumn[protocol]] === 1));
  for (const [country, rows] of countries) groups.set(`countries/${country}`, rows);
  const meta = {
    timestamp,
    scope: SNAPSHOT_SCOPE,
    max_check_age_hours: MAX_CHECK_AGE_HOURS,
    status: records.length ? "available" : "no-verified-working-proxies",
    source: { api_base: apiBaseUrl, site_url: siteUrl, working_only: true },
    collection: { received: fetched.length, excluded_unchecked_failed_or_stale: fetched.length - records.length, complete: true },
    checks: { oldest: records.length ? records.map((r) => r.last_checked).sort()[0] : null, newest: records.length ? records.map((r) => r.last_checked).sort().at(-1) : null },
    totals: {
      all: records.length,
      protocols: Object.fromEntries(protocols.map((p) => [p, groups.get(`protocols/${p}`).length])),
      countries: Object.fromEntries([...countries].sort(([a], [b]) => a.localeCompare(b)).map(([code, rows]) => [code, rows.length])),
    },
    downloads: {
      all: downloads("all"),
      protocols: Object.fromEntries(protocols.map((p) => [p, downloads(`protocols/${p}`)])),
      countries: Object.fromEntries([...countries.keys()].map((code) => [code, downloads(`countries/${code}`)])),
    },
    generated_by: { script: "scripts/refresh.mjs", repo_slug: repoSlug, repo_branch: repoBranch },
  };
  const readme = await renderReadme(meta);

  // Build the complete generated surface in a sibling staging directory. The
  // existing snapshot stays untouched until every generated file is present.
  const stagingRoot = path.join(outputDir, `.snapshot-stage-${process.pid}-${Date.now()}`);
  await mkdir(stagingRoot, { recursive: true });
  try {
    for (const [name, rows] of groups) {
      await writeTextAt(stagingRoot, `proxies/${name}/data.json`, JSON.stringify({ data: rows }, null, 2) + "\n");
      await writeTextAt(stagingRoot, `proxies/${name}/data.txt`, rows.map((r) => `${r.ip}:${r.port}`).join("\n") + (rows.length ? "\n" : ""));
      await writeTextAt(stagingRoot, `proxies/${name}/data.csv`, serializeSnapshotCsv(rows));
    }
    await writeTextAt(stagingRoot, "proxies/meta/data.json", JSON.stringify(meta, null, 2) + "\n");
    await writeTextAt(stagingRoot, "README.md", readme);
    await replaceGeneratedSnapshot(stagingRoot);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ scope: meta.scope, timestamp, total: records.length, country_groups: countries.size, known_countries: [...countries.keys()].filter((c) => c !== "ZZ").length, ...meta.collection }));
}

function downloads(group) {
  return Object.fromEntries(["json", "txt", "csv"].map((format) => [format, `${downloadBase}/proxies/${group}/data.${format}`]));
}

function liveLink(route) {
  const url = new URL(route, siteUrl);
  url.search = new URLSearchParams({ utm_source: "github", utm_medium: "repo_readme", utm_campaign: "free_proxy_list_repo" }).toString();
  return url.toString();
}

async function renderReadme(meta) {
  const template = await readFile(path.join(scaffoldRoot, "templates/README.md.tmpl"), "utf8");
  const countries = Object.entries(meta.totals.countries);
  const known = countries.filter(([code]) => code !== "ZZ");
  const replacements = {
    SITE_URL: siteUrl, REPO_SLUG: repoSlug, REPO_BRANCH: repoBranch,
    PROXY_LIST_URL: liveLink("/free-proxy-list"), BULK_CHECKER_URL: liveLink("/tools/bulk-checker"), API_DOCS_URL: liveLink("/docs/api"),
    UPDATED_AT: `${meta.timestamp} (UTC)`, TOTAL_ALL: String(meta.totals.all), COUNTRY_COUNT: String(known.length), UNKNOWN_LOCATION_COUNT: String(meta.totals.countries.ZZ ?? 0),
    PROTOCOL_PAGE_LINKS: protocols.map((p) => `- [${p.toUpperCase()} proxy list](${liveLink(`/free-proxy-list/protocol/${p}`)}) — ${meta.totals.protocols[p]} in this verified snapshot`).join("\n"),
    COUNTRY_PAGE_LINKS: known.sort(([, a], [, b]) => b - a).slice(0, 8).map(([c, n]) => `- [${c} proxy list](${liveLink(`/free-proxy-list/country/${c.toLowerCase()}`)}) — ${n} in this verified snapshot`).join("\n") || "No country metadata is available in this snapshot; unknown locations are grouped under ZZ.",
    US_ROW: meta.totals.countries.US ? `| US Proxies | ${meta.totals.countries.US} | [data.json](${meta.downloads.countries.US.json}) | [data.txt](${meta.downloads.countries.US.txt}) | [data.csv](${meta.downloads.countries.US.csv}) |` : "",
  };
  for (const format of ["json", "txt", "csv"]) {
    replacements[`ALL_${format.toUpperCase()}_URL`] = meta.downloads.all[format];
    for (const p of protocols) replacements[`${p.toUpperCase()}_${format.toUpperCase()}_URL`] = meta.downloads.protocols[p][format];
  }
  for (const p of protocols) replacements[`TOTAL_${p.toUpperCase()}`] = String(meta.totals.protocols[p]);
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in replacements)) throw new Error(`Unknown README placeholder ${key}`);
    return replacements[key];
  });
}

async function writeText(relativePath, content) {
  await writeTextAt(outputDir, relativePath, content);
}

async function writeTextAt(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function replaceGeneratedSnapshot(stagingRoot) {
  const liveProxies = path.join(outputDir, "proxies");
  const stagedProxies = path.join(stagingRoot, "proxies");
  const stagedReadme = path.join(stagingRoot, "README.md");
  const backupProxies = path.join(outputDir, `.snapshot-previous-${process.pid}-${Date.now()}`);
  const hadLiveProxies = await exists(liveProxies);
  let movedOld = false;
  let installedNew = false;

  try {
    if (hadLiveProxies) {
      await rename(liveProxies, backupProxies);
      movedOld = true;
    }
    await rename(stagedProxies, liveProxies);
    installedNew = true;
    await rename(stagedReadme, path.join(outputDir, "README.md"));
    if (movedOld) {
      await rm(backupProxies, { recursive: true, force: true });
    }
  } catch (error) {
    if (installedNew && await exists(liveProxies)) {
      await rename(liveProxies, stagedProxies).catch(() => {});
    }
    if (movedOld && await exists(backupProxies) && !(await exists(liveProxies))) {
      await rename(backupProxies, liveProxies).catch(() => {});
    }
    throw error;
  }
}
