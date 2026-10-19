#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_SCOPE, MAX_CHECK_AGE_HOURS, assertSnapshotRecords, endpointKey, serializeSnapshotCsv } from "./snapshot-quality.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--root");
const root = path.resolve(at >= 0 ? args[at + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const protocols = { http: "http", https: "ssl", socks4: "socks4", socks5: "socks5" };

main().catch((error) => {
  console.error(`Distribution validation failed: ${error.message}`);
  process.exitCode = 1;
});

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
function readText(name) {
  return readFile(path.join(root, name), "utf8");
}
async function readJson(name) {
  return JSON.parse(await readText(name));
}

async function main() {
  const meta = await readJson("proxies/meta/data.json");
  const all = (await readJson("proxies/all/data.json")).data;
  requireValue(meta.scope === SNAPSHOT_SCOPE, "snapshot scope must be verified-working");
  requireValue(meta.max_check_age_hours === MAX_CHECK_AGE_HOURS, "verification freshness window changed without a contract update");
  requireValue(meta.source?.api_base === "https://api.socks5proxies.com" && meta.source?.site_url === "https://socks5proxies.com", "snapshot must name its production sources");
  requireValue(meta.source?.working_only === true && meta.collection?.complete === true, "snapshot must come from a complete working-only collection");
  assertSnapshotRecords(all, meta.timestamp);
  requireValue(meta.totals?.all === all.length, "all count disagrees with actual records");
  requireValue(meta.collection.received - meta.collection.excluded_unchecked_failed_or_stale === all.length, "collection accounting disagrees with actual records");
  requireValue(meta.status === (all.length ? "available" : "no-verified-working-proxies"), "empty/available status disagrees with records");
  requireValue(meta.generated_by?.script === "scripts/refresh.mjs", "snapshot generator is missing");
  await checkGroup("all", all, meta);

  for (const [protocol, column] of Object.entries(protocols)) {
    const expected = all.filter((r) => r[column] === 1);
    requireValue(meta.totals.protocols[protocol] === expected.length, `${protocol} metadata count differs`);
    await checkGroup(`protocols/${protocol}`, expected, meta);
    requireValue(meta.downloads?.protocols?.[protocol]?.txt?.endsWith(`/protocols/${protocol}/data.txt`), `missing ${protocol} download`);
  }
  const countryCodes = [...new Set(all.map((r) => r.country_code))].sort();
  requireValue(JSON.stringify(Object.keys(meta.totals.countries).sort()) === JSON.stringify(countryCodes), "country metadata includes missing or phantom groups");
  let storedCountries = [];
  try {
    storedCountries = (await readdir(path.join(root, "proxies/countries"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  requireValue(JSON.stringify(storedCountries) === JSON.stringify(countryCodes), "stale country directories remain outside this snapshot");
  for (const code of countryCodes) {
    const expected = all.filter((r) => r.country_code === code);
    requireValue(meta.totals.countries[code] === expected.length, `${code} country count differs`);
    await checkGroup(`countries/${code}`, expected, meta);
    requireValue(meta.downloads?.countries?.[code]?.txt?.endsWith(`/countries/${code}/data.txt`), `missing ${code} download`);
  }

  const readme = await readText("README.md");
  // The data sources section carries the credits the CC BY 4.0 lists ask for (proxio's also asks for its link).
  for (const phrase of ["Snapshot of public proxy endpoints", "verified-working", "every 6 hours", "Latest snapshot:", "## Source", "not a guarantee", meta.timestamp, "## Data sources and licences", "](https://proxio.io)", "proxmint/free-proxy-list", "does not relicense"]) {
    requireValue(readme.includes(phrase), `README missing ${phrase}`);
  }
  requireValue(!readme.includes("{{"), "README has unresolved placeholders");
  for (const match of readme.matchAll(/https:\/\/socks5proxies\.com\/free-proxy-list\/country\/([a-z]{2})/g)) {
    requireValue(countryCodes.includes(match[1].toUpperCase()) && match[1] !== "zz", "README invents a country deep link");
  }
  const template = await readText("templates/README.md.tmpl");
  requireValue(template.includes("{{COUNTRY_PAGE_LINKS}}") && template.includes("{{PROTOCOL_PAGE_LINKS}}"), "README template lacks actual facet placeholders");
  // Keep the existing public-repository ship route unchanged; this only reads
  // its already-present scaffold, and never contacts or writes to GitHub.
  const workflow = await readText(".github/workflows/refresh.yml");
  for (const snippet of ['cron: "15 */6 * * *"', "node scripts/refresh.mjs", "node scripts/validate.mjs", "git add README.md proxies", "https://purge.jsdelivr.net/gh/"]) {
    requireValue(workflow.includes(snippet), `existing refresh scaffold missing ${snippet}`);
  }
  const refresh = await readText("scripts/refresh.mjs");
  requireValue(refresh.includes("fetchWorkingSnapshot") && refresh.includes("assertSnapshotRecords") && refresh.includes("--readme-only"), "refresh bypasses its evidence guards");
  console.log(`Distribution validation passed: ${all.length} verified-working rows, ${countryCodes.filter((c) => c !== "ZZ").length} known countries, no quantity floor.`);
}

async function checkGroup(name, expected, meta) {
  const payload = await readJson(`proxies/${name}/data.json`);
  assertSnapshotRecords(payload.data, meta.timestamp);
  requireValue(JSON.stringify(payload.data) === JSON.stringify(expected), `${name} is not the exact subset of all records`);
  const txt = await readText(`proxies/${name}/data.txt`);
  const expectedTxt = expected.map(endpointKey).join("\n") + (expected.length ? "\n" : "");
  requireValue(txt === expectedTxt, `${name} TXT does not match JSON endpoints`);
  requireValue(await readText(`proxies/${name}/data.csv`) === serializeSnapshotCsv(expected), `${name} CSV does not match JSON evidence`);
}
