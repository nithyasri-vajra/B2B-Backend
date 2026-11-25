import { ObjectId } from "mongodb";

export const parseId = (value) => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value)
  ? new ObjectId(value) : null;
export const cleanText = (value) => typeof value === "string" ? value.trim() : "";
export const idFilter = (id) => ({ $in: [id, String(id)] });

export function registerBrandRoutes(router, { db, mongo, current, isPlatformAdmin, hasClientRole }) {
  const brands = db.collection("brands");
  const sources = db.collection("knowledgeSources");
  const records = db.collection("knowledgeRecords");
  const versions = db.collection("knowledgeVersions");
  const agents = db.collection("agents");
  const audit = (actor, clientId, eventType, targetId, details, session) =>
    db.collection("audit_events").insertOne({
      clientId, eventType, outcome: "success", actorUserId: actor._id, targetId, occurredAt: new Date(), details,
    }, { session });

  const brandPath = "/workflow/brands/:clientId";
  async function scope(req, res, next) {
    const { user } = await current(req);
    if (!user) return res.sendStatus(401);
    const clientId = parseId(req.params.clientId);
    if (!clientId) return res.sendStatus(400);
    const brand = await brands.findOne({ _id: clientId });
    if (!brand) return res.sendStatus(404);
    const role = (...roles) => hasClientRole(user, String(clientId), roles);
    const admin = isPlatformAdmin(user);
    if (!admin && !role("knowledge_admin", "approver", "marketing_operator", "viewer"))
      return res.sendStatus(403);
    res.locals.brandScope = { user, clientId, brand, role, admin };
    next();
  }

  router.get(brandPath, scope, (req, res) => {
    const { brand } = res.locals.brandScope;
    res.json({ brand });
  });

  router.patch(brandPath, scope, async (req, res) => {
    const { user, clientId, brand, role, admin } = res.locals.brandScope;
    const manager = role("knowledge_admin") && String(brand.brandManagerUserId) === String(user._id);
    if (!admin && !manager) return res.sendStatus(403);
    const update = {};
    for (const key of ["name", "website", "industry", "timezone", "spelling", "logoRef"]) {
      if (!Object.hasOwn(req.body ?? {}, key)) continue;
      const value = cleanText(req.body[key]);
      if ((!value && ["name", "website", "timezone"].includes(key)) || value.length > 2000)
        return res.sendStatus(400);
      update[key] = value || null;
    }
    if (Object.hasOwn(req.body ?? {}, "status")) {
      if (!admin) return res.sendStatus(403);
      if (!["active", "setting_up", "archived"].includes(req.body.status)) return res.sendStatus(400);
      update.status = req.body.status;
    }
    for (const key of ["defaultApproverUserId", "backupApproverUserId"]) {
      if (!Object.hasOwn(req.body ?? {}, key)) continue;
      const id = parseId(req.body[key]);
      if (!id) return res.sendStatus(400);
      const approver = await db.collection("users").findOne({ _id: id });
      if (!hasClientRole(approver, String(clientId), ["approver"])) return res.sendStatus(422);
      update[key] = id;
    }
    const primary = update.defaultApproverUserId ?? brand.defaultApproverUserId;
    const backup = update.backupApproverUserId ?? brand.backupApproverUserId;
    if ((update.defaultApproverUserId || update.backupApproverUserId) && primary && backup &&
        String(primary) === String(backup)) return res.sendStatus(422);
    if (!Object.keys(update).length) return res.sendStatus(400);
    const saved = await mongo.withSession((session) => session.withTransaction(async () => {
      const result = await brands.findOneAndUpdate({ _id: clientId, updatedAt: brand.updatedAt ?? null },
        { $set: { ...update, updatedAt: new Date() } }, { session, returnDocument: "after" });
      if (result) await audit(user, clientId, "brand_updated", clientId, {
        before: Object.fromEntries(Object.keys(update).map((key) => [key, brand[key] ?? null])), after: update,
      }, session);
      return result;
    }));
    if (!saved) return res.sendStatus(409);
    res.json({ brand: saved });
  });

  router.get(brandPath + "/knowledge/readiness", scope, async (req, res) => {
    const { brand, clientId } = res.locals.brandScope;
    const version = brand.publishedKnowledgeVersionId && await versions.findOne({
      _id: brand.publishedKnowledgeVersionId, clientId: idFilter(clientId), status: "published",
    }, { projection: { readiness: 1, version: 1 } });
    res.json({ readiness: version?.readiness ?? null, version: version?.version ?? null });
  });

  router.get(brandPath + "/knowledge/sources", scope, async (req, res) => {
    const { clientId, admin, role } = res.locals.brandScope;
    if (!admin && !role("knowledge_admin")) return res.sendStatus(403);
    const filter = { clientId };
    const [active, legacy] = await Promise.all([
      sources.find(filter).toArray(), db.collection("knowledgeSource").find(filter).toArray(),
    ]);
    const known = new Set(active.map(({ _id }) => String(_id)));
    res.json({ knowledgeSources: [...active, ...legacy.filter(({ _id }) => !known.has(String(_id)))
      .map(({ area, ...source }) => ({ ...source, areas: source.areas ?? (area ? [area] : []) }))] });
  });

  router.post(brandPath + "/knowledge/sources", scope, async (req, res) => {
    const { user, role, admin, clientId, brand } = res.locals.brandScope;
    if (!admin && !role("knowledge_admin")) return res.sendStatus(403);
    if (brand.status === "archived") return res.sendStatus(409);
    const { sourceType, areas } = req.body ?? {};
    const title = cleanText(req.body?.title);
    const fileRef = cleanText(req.body?.fileRef);
    const url = cleanText(req.body?.url);
    if (!title || !Array.isArray(areas) || !areas.length || areas.some((area) => !cleanText(area)) ||
        !["file", "link"].includes(sourceType) || (sourceType === "file" ? !fileRef : !/^https?:\/\//i.test(url)))
      return res.sendStatus(400);
    const now = new Date();
    const source = {
      _id: new ObjectId(), clientId, sourceType, title, areas: [...new Set(areas.map(cleanText))],
      ...(sourceType === "file" ? { fileRef } : { url }), processingStatus: "pending",
      uploadedByUserId: user._id, createdAt: now, updatedAt: now,
    };
    await mongo.withSession((session) => session.withTransaction(async () => {
      await sources.insertOne(source, { session });
      await audit(user, clientId, "knowledge_source_added", source._id, {}, session);
    }));
    res.status(201).json({ source });
  });

  router.get(brandPath + "/knowledge/records", scope, async (req, res) => {
    const { clientId, role, admin } = res.locals.brandScope;
    if (!admin && !role("knowledge_admin", "approver", "marketing_operator")) return res.sendStatus(403);
    const filter = { clientId };
    for (const key of ["area", "recordType"]) {
      if (typeof req.query[key] === "string") filter[key] = req.query[key];
    }
    const rows = await records.find(filter).sort({ updatedAt: -1 }).toArray();
    if (admin || role("knowledge_admin")) return res.json({ knowledgeRecords: rows });
    res.json({ knowledgeRecords: rows.flatMap((record) => {
      const revision = record.revisions.find((entry) => entry.revision === record.currentRevision);
      return revision?.reviewStatus === "approved" ? [{ ...record, revisions: [revision] }] : [];
    }) });
  });

  router.post(brandPath + "/knowledge/records", scope, async (req, res) => {
    const { clientId, role, user, brand } = res.locals.brandScope;
    if (!role("knowledge_admin")) return res.sendStatus(403);
    if (brand.status === "archived") return res.sendStatus(409);
    const { sourceId: sourceKey, area, recordType, statement } = req.body ?? {};
    const sourceId = parseId(sourceKey);
    if (!sourceId || !cleanText(area) || !cleanText(recordType) || !cleanText(statement))
      return res.sendStatus(400);
    const source = await sources.findOne({ _id: sourceId, clientId }) ??
      await db.collection("knowledgeSource").findOne({ _id: sourceId, clientId });
    if (!source || !(source.areas ?? [source.area]).includes(area)) return res.sendStatus(422);
    const now = new Date();
    const record = {
      _id: new ObjectId(), clientId, sourceId, area, recordType, currentRevision: 1,
      revisions: [{ revision: 1, statement: statement.trim(), reviewStatus: "captured" }],
      createdAt: now, updatedAt: now,
    };
    await mongo.withSession((session) => session.withTransaction(async () => {
      await records.insertOne(record, { session });
      await audit(user, clientId, "knowledge_record_created", record._id, {}, session);
    }));
    res.status(201).json({ record });
  });

  router.post(brandPath + "/knowledge/records/:recordId/revisions", scope, async (req, res) => {
    const { clientId, role, user, brand } = res.locals.brandScope;
    if (!role("knowledge_admin")) return res.sendStatus(403);
    if (brand.status === "archived") return res.sendStatus(409);
    const _id = parseId(req.params.recordId);
    const { currentRevision, reviewStatus } = req.body ?? {};
    if (!_id || !Number.isSafeInteger(currentRevision) || currentRevision < 1 ||
        !["captured", "verified", "approved", "disputed", "superseded", "expired", "rejected"].includes(reviewStatus))
      return res.sendStatus(400);
    const existing = await records.findOne({ _id, clientId, currentRevision });
    const previous = existing?.revisions.find((entry) => entry.revision === currentRevision);
    if (!previous) return res.sendStatus(409);
    const changes = {};
    for (const key of ["statement", "sourceReference", "evidenceGrade", "permittedWording",
      "usagePermission", "agentKey", "conflictNotes"]) {
      if (!Object.hasOwn(req.body, key)) continue;
      if (typeof req.body[key] !== "string") return res.sendStatus(400);
      changes[key] = req.body[key].trim();
    }
    if (changes.evidenceGrade && !["A", "B", "C", "D"].includes(changes.evidenceGrade))
      return res.sendStatus(400);
    if (Object.hasOwn(changes, "statement") && !changes.statement) return res.sendStatus(400);
    if (Object.hasOwn(req.body, "reviewDueAt")) {
      const value = req.body.reviewDueAt;
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return res.sendStatus(400);
      changes.reviewDueAt = new Date(value);
    }
    const now = new Date();
    const revision = { ...previous, ...changes, revision: currentRevision + 1,
      reviewStatus, reviewedByUserId: user._id, reviewedAt: now };
    const saved = await mongo.withSession((session) => session.withTransaction(async () => {
      const record = await records.findOneAndUpdate({ _id, clientId, currentRevision }, {
        $set: { currentRevision: revision.revision, updatedAt: now }, $push: { revisions: revision },
      }, { session, returnDocument: "after" });
      if (record) await audit(user, clientId, "knowledge_record_reviewed", _id, {
        revision: revision.revision, reviewStatus,
      }, session);
      return record;
    }));
    if (!saved) return res.sendStatus(409);
    res.json({ record: saved });
  });

  router.post(brandPath + "/knowledge/versions", scope, async (req, res) => {
    const { user, clientId, role, brand } = res.locals.brandScope;
    if (!role("knowledge_admin")) return res.sendStatus(403);
    if (brand.status === "archived") return res.sendStatus(409);
    const now = new Date();
    const published = await mongo.withSession((session) => session.withTransaction(async () => {
      const versionId = new ObjectId();
      const approvedRecords = await records.aggregate([
        { $match: { clientId } }, { $unwind: "$revisions" },
        { $match: { $expr: { $eq: ["$currentRevision", "$revisions.revision"] },
          "revisions.reviewStatus": "approved", "revisions.evidenceGrade": { $in: ["A", "B", "C"] },
          $or: [{ "revisions.reviewDueAt": null }, { "revisions.reviewDueAt": { $gt: now } }] } },
        { $project: { revision: "$currentRevision" } },
      ], { session }).toArray();
      if (!approvedRecords.length) return null;
      const lock = await brands.updateOne({
        _id: clientId, status: { $ne: "archived" },
        publishedKnowledgeVersionId: brand.publishedKnowledgeVersionId ?? null,
      }, { $set: { publishedKnowledgeVersionId: versionId, updatedAt: now } }, { session });
      if (!lock.matchedCount) return null;
      const latest = await versions.findOne({ clientId: idFilter(clientId) }, {
        session, sort: { version: -1 }, projection: { version: 1 },
      });
      const version = {
        _id: versionId, clientId, version: (latest?.version ?? 0) + 1, status: "published",
        recordRevisions: approvedRecords.map(({ _id, revision }) => ({ recordId: _id, revision })),
        publishedByUserId: user._id, publishedAt: now,
      };
      await versions.insertOne(version, { session });
      await audit(user, clientId, "knowledge_version_published", versionId, { version: version.version }, session);
      return version;
    }));
    if (!published) return res.sendStatus(409);
    res.status(201).json({ knowledgeVersion: published });
  });

  router.get("/workflow/agents", async (req, res) => {
    const { user } = await current(req);
    if (!isPlatformAdmin(user)) return res.sendStatus(403);
    const rows = await agents.find().project({
      agentKey: 1, name: 1, outputType: 1, releaseStatus: 1, currentVersion: 1,
      "versions.version": 1, "versions.pipeline.stageKey": 1, "versions.pipeline.order": 1,
      "versions.pipeline.gate": 1, "versions.runLimits": 1, "versions.briefTemplate.version": 1,
    }).sort({ name: 1 }).toArray();
    res.json({ agents: rows });
  });
}
