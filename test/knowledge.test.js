// Knowledge upload, publish and claim checks against a small in-memory stand-in for MongoDB.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ObjectId } from "mongodb";
import { assessReadiness, registerBrandRoutes, resolvePublishedKnowledge } from "../brand-routes.js";
import { verifyDraftClaims } from "../workflow-routes.js";

const get = (doc, path) => path.split(".").reduce((value, key) => value?.[key], doc);
const same = (a, b) => (a instanceof ObjectId || b instanceof ObjectId) ? String(a) === String(b)
  : a instanceof Date || b instanceof Date ? +a === +b : a === b;
function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((part) => matches(doc, part));
    if (key === "$expr") { const [a, b] = condition.$eq; return same(get(doc, a.slice(1)), get(doc, b.slice(1))); }
    const value = get(doc, key);
    if (condition && typeof condition === "object" && !(condition instanceof ObjectId) && !(condition instanceof Date)) {
      if ("$in" in condition) return condition.$in.some((entry) => same(value, entry));
      if ("$ne" in condition) return !same(value, condition.$ne);
      if ("$gt" in condition) return value != null && value > condition.$gt;
    }
    return condition === null ? value == null : same(value, condition);
  });
}
function collection() {
  const rows = [];
  const sorted = (list, sort) => {
    const [[key, dir] = []] = Object.entries(sort ?? {});
    return key ? [...list].sort((a, b) => (get(a, key) > get(b, key) ? 1 : -1) * dir) : list;
  };
  const apply = (doc, update) => {
    Object.assign(doc, update.$set ?? {});
    for (const [key, value] of Object.entries(update.$push ?? {})) doc[key] = [...(doc[key] ?? []), value];
    return doc;
  };
  return {
    rows,
    async findOne(filter, options = {}) { return sorted(rows.filter((row) => matches(row, filter)), options.sort)[0] ?? null; },
    find(filter) { let list = rows.filter((row) => matches(row, filter)); const cursor = {
      sort(sort) { list = sorted(list, sort); return cursor; }, project() { return cursor; }, async toArray() { return list; } }; return cursor; },
    async insertOne(doc) { rows.push({ ...doc }); return { insertedId: doc._id }; },
    async insertMany(docs) { for (const doc of docs) rows.push({ ...doc }); return {}; },
    async updateOne(filter, update) { const row = rows.find((entry) => matches(entry, filter)); if (row) apply(row, update); return { matchedCount: row ? 1 : 0 }; },
    async findOneAndUpdate(filter, update) { const row = rows.find((entry) => matches(entry, filter)); return row ? apply(row, update) : null; },
    async deleteOne() { return {}; }, async deleteMany() { return {}; },
    async createIndex() { return "ok"; }, listIndexes() { return { toArray: async () => [] }; },
    aggregate(pipeline) { let list = rows.map((row) => ({ ...row })); for (const stage of pipeline) {
      if (stage.$match) list = list.filter((row) => matches(row, stage.$match));
      if (stage.$unwind) { const key = stage.$unwind.slice(1); list = list.flatMap((row) => (row[key] ?? []).map((entry) => ({ ...row, [key]: entry }))); }
      if (stage.$project) list = list.map((row) => ({ _id: row._id, ...Object.fromEntries(Object.entries(stage.$project)
        .map(([key, value]) => [key, typeof value === "string" ? get(row, value.slice(1)) : row[key]])) }));
    } return { toArray: async () => list }; },
  };
}

async function setup() {
  const collections = new Map();
  const db = { collection: (name) => { if (!collections.has(name)) collections.set(name, collection()); return collections.get(name); } };
  const clientId = new ObjectId();
  await db.collection("brands").insertOne({ _id: clientId, name: "Vajra Global", status: "active" });
  const user = { _id: new ObjectId(), status: "active", email: "admin@vajraglobal.com" };
  const router = express.Router();
  registerBrandRoutes(router, {
    db, mongo: { withSession: (fn) => fn({ withTransaction: (work) => work() }) },
    current: async () => ({ user }), isPlatformAdmin: () => true, hasClientRole: () => true,
  });
  const app = express(); app.use(express.json()); app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/workflow/brands/${clientId}`;
  const upload = async (name, text, areas = ["general"]) => {
    const form = new FormData();
    form.append("file", new File([text], name));
    for (const area of areas) form.append("areas", area);
    const res = await fetch(base + "/knowledge/sources/upload", { method: "POST", body: form });
    return { status: res.status, body: await res.json() };
  };
  const post = async (path, body) => { const res = await fetch(base + path, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: res.status === 409 ? null : await res.json() }; };
  return { db, clientId, upload, post, close: () => server.close() };
}

test("Markdown and CSV uploads become records; the same file name adds the next revision", async () => {
  const t = await setup();
  try {
    const md = await t.upload("claims.md", "# Claims\n\n- Vajra Global works with HubSpot.", ["claims"]);
    assert.equal(md.status, 201);
    assert.equal(md.body.record.fileName, "claims.md");
    assert.equal(md.body.record.revisions[0].reviewStatus, "needs_review");
    const csv = await t.upload("learning_posts.csv", "﻿date,copy,impressions\n2026-11-01,Hello,120\n", ["learning"]);
    assert.equal(csv.status, 201);
    assert.equal(csv.body.source.processingStatus, "completed");
    assert.match(csv.body.record.revisions[0].statement, /^date,copy,impressions/);
    const again = await t.upload("claims.md", "# Claims v2", ["claims"]);
    assert.equal(again.status, 200);
    assert.equal(again.body.revised, true);
    assert.equal(again.body.record.currentRevision, 2);
    assert.equal(again.body.record.revisions.length, 2);
    assert.equal(t.db.collection("knowledgeRecords").rows.length, 2, "no duplicate record for the same file");
    assert.equal(t.db.collection("knowledgeSources").rows.length, 2, "no duplicate source for the same file");
  } finally { t.close(); }
});

test("Publishing takes every approved file without a grade, keeps claims.md, and saves the note", async () => {
  const t = await setup();
  try {
    const claims = (await t.upload("claims.md", "# Claims\n\n- We run AI marketing.", ["claims"])).body.record;
    const posts = (await t.upload("learning_posts.csv", "date,copy\n2026-11-01,Hello", ["learning"])).body.record;
    const pending = (await t.upload("market.md", "# Market", ["market"])).body.record;
    for (const record of [claims, posts]) {
      const res = await t.post(`/knowledge/records/${record._id}/revisions`, { currentRevision: 1, reviewStatus: "approved" });
      assert.equal(res.status, 200);
    }
    const published = await t.post("/knowledge/versions", { note: "First full knowledge set" });
    assert.equal(published.status, 201);
    assert.equal(published.body.knowledgeVersion.note, "First full knowledge set");
    const ids = published.body.knowledgeVersion.recordRevisions.map(({ recordId }) => String(recordId)).sort();
    assert.deepEqual(ids, [String(claims._id), String(posts._id)].sort());
    assert.ok(!ids.includes(String(pending._id)), "files waiting for review are not published");

    const brand = await t.db.collection("brands").findOne({ _id: t.clientId });
    const snapshot = await resolvePublishedKnowledge(t.db, brand);
    const { knowledge, readiness } = assessReadiness(snapshot);
    assert.equal(readiness.verdict, "READY");
    assert.deepEqual(knowledge.map(({ fileName }) => fileName).sort(), ["claims.md", "learning_posts.csv"]);
  } finally { t.close(); }
});

test("Claims QA lists are checked against published knowledge files", () => {
  const recordId = new ObjectId();
  const knowledge = [{ recordId, revision: 2, recordType: "document", area: "claims", reviewStatus: "approved",
    statement: "# Claims\n- Vajra Global works across HubSpot." }];
  const text = "Vajra Global works across HubSpot and Salesforce.";
  assert.equal(verifyDraftClaims(text, [{ quote: "Vajra Global works across HubSpot", recordId: String(recordId), revision: "2" }], knowledge), true);
  assert.equal(verifyDraftClaims(text, [{ quote: "not in the draft", recordId: String(recordId), revision: "2" }], knowledge), false);
  assert.equal(verifyDraftClaims(text, [{ quote: "Vajra Global works across HubSpot", recordId: "", revision: "" }], knowledge), false);
  assert.equal(verifyDraftClaims(text, [], knowledge), true);
});
