import test from "node:test";
import assert from "node:assert/strict";
import { assertSnapshotRecords, fetchWorkingSnapshot, isVerifiedWorking, serializeSnapshotCsv } from "./snapshot-quality.mjs";

const timestamp = "2026-09-19T14:00:00Z";
const row = { ip: "192.0.2.1", port: 1080, country_code: "ZZ", last_checked: "2026-09-19T13:30:00Z", health_score: 90 };
const reply = (data, total) => new Response(JSON.stringify({ data, meta: { total } }), { status: 200 });

test("only a recent successful own check is verified-working", () => {
  assert.equal(isVerifiedWorking(row, timestamp), true);
  for (const patch of [{ last_checked: undefined }, { last_checked: "invalid" }, { health_score: 0 }, { last_checked: "2026-09-19T10:00:00Z" }, { last_checked: "2026-09-20T00:00:00Z" }]) {
    assert.equal(isVerifiedWorking({ ...row, ...patch }, timestamp), false);
    assert.throws(() => assertSnapshotRecords([{ ...row, ...patch }], timestamp));
  }
});

test("a small or genuinely empty successful snapshot needs no quantity padding", () => {
  assert.doesNotThrow(() => assertSnapshotRecords([], timestamp));
  assert.doesNotThrow(() => assertSnapshotRecords([row], timestamp));
});

test("duplicate, invalid endpoints and unsafe country groups fail closed", () => {
  assert.throws(() => assertSnapshotRecords([row, row], timestamp), /Duplicate/);
  assert.throws(() => assertSnapshotRecords([{ ...row, port: 70000 }], timestamp), /invalid/);
  assert.throws(() => assertSnapshotRecords([{ ...row, country_code: "../../outside" }], timestamp), /country/);
});

test("pagination requests working_only, uses 100-row pages, and returns all 125 rows", async () => {
  const rows = Array.from({ length: 125 }, (_, i) => ({ ...row, ip: `192.0.2.${i + 1}` }));
  const offsets = [];
  const all = await fetchWorkingSnapshot({ apiBaseUrl: "https://api.example.test", fetchImpl: async (url) => {
    assert.equal(url.searchParams.get("working_only"), "true");
    assert.equal(url.searchParams.get("limit"), "100");
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    return reply(rows.slice(offset, offset + 100), rows.length);
  } });
  assert.equal(all.length, 125);
  assert.deepEqual(offsets, [0, 100]);
});

test("zero working rows is distinct from an invalid API response", async () => {
  assert.deepEqual(await fetchWorkingSnapshot({ apiBaseUrl: "https://api.example.test", fetchImpl: async () => reply([], 0) }), []);
  await assert.rejects(fetchWorkingSnapshot({ apiBaseUrl: "https://api.example.test", fetchImpl: async () => new Response('{"error":"unavailable"}') }), /invalid/);
});

test("an interrupted or changing collection is never a complete snapshot", async () => {
  let page = 0;
  await assert.rejects(fetchWorkingSnapshot({ apiBaseUrl: "https://api.example.test", fetchImpl: async () => page++ === 0 ? reply([row], 2) : reply([], 2) }), /ended before/);
  page = 0;
  await assert.rejects(fetchWorkingSnapshot({ apiBaseUrl: "https://api.example.test", fetchImpl: async () => page++ === 0 ? reply([row], 2) : reply([row], 3) }), /changed/);
  await assert.rejects(fetchWorkingSnapshot({ apiBaseUrl: "https://api.example.test", fetchImpl: async () => new Response("unavailable", { status: 503 }) }), /503/);
});

test("CSV keeps verification evidence and escapes quoted/newline metadata", () => {
  const csv = serializeSnapshotCsv([{ ...row, country_name: 'A "quoted"\nname' }]);
  assert.match(csv, /last_checked,health_score/);
  assert.ok(csv.includes('"A ""quoted""\nname"'));
  assert.ok(csv.includes('"2026-09-19T13:30:00Z","90"'));
});
