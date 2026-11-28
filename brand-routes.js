import { createHash } from "node:crypto";
import { extname } from "node:path";
import { finished } from "node:stream/promises";
import express, { raw } from "express";
import { modelStatus, skillStatus } from "./skill-status.js";
import { GridFSBucket, ObjectId } from "mongodb";

const maxKnowledgeFileBytes = 2 * 1024 * 1024;
const knowledgeFileTypes = new Set([
  ".md", ".pdf", ".docx", ".pptx", ".xlsx", ".csv", ".txt", ".vtt", ".png", ".jpg", ".jpeg", ".webp", ".gif",
]);

export const parseId = (value) => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value)
  ? new ObjectId(value) : null;
export const cleanText = (value) => typeof value === "string" ? value.trim() : "";
export const idFilter = (id) => ({ $in: [id, String(id)] });

const brandRoles = ["brand_manager", "approver", "operator", "viewer"];
const brandEmail = /^[^\s@]+@vajraglobal\.com$/;

const knowledgeAreas = new Map([
  ["brand.md", ["D1", "D3"]],
  ["claims.md", ["D2"]],
  ["market.md", ["D6"]],
  ["operations.md", ["D4", "D5", "D7"]],
  ["learning.md", ["D8"]],
]);
const claimPermission = (value) => cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
const claimPermissions = new Set(["public", "restricted", "internal_only"]);
const isClaim = ({ area, recordType }) => /^claims?$/i.test(cleanText(area)) ||
  /\bclaims?\b/i.test(cleanText(recordType).replace(/_/g, " "));

function canReuseClaim(revision, now) {
  return revision?.reviewStatus === "approved" &&
    ["A", "B", "C"].includes(revision.evidenceGrade) &&
    Boolean(cleanText(revision.sourceReference)) &&
    claimPermission(revision.usagePermission) === "public" &&
    (revision.reviewDueAt == null || new Date(revision.reviewDueAt) > now);
}

export async function resolvePublishedKnowledge(db, brand, {
  versionId = brand?.publishedKnowledgeVersionId, session, now = new Date(),
} = {}) {
  const id = parseId(String(versionId));
  if (!brand || !id) return { version: null, records: [], missing: false };
  const version = await db.collection("knowledgeVersions").findOne({
    _id: id, clientId: idFilter(brand._id), status: "published",
  }, { session });
  const refs = version?.recordRevisions ?? [];
  if (!refs.length) return { version, records: [], missing: false };
  const rows = await db.collection("knowledgeRecords").find({
    clientId: idFilter(brand._id), _id: { $in: refs.map(({ recordId }) => parseId(String(recordId))).filter(Boolean) },
  }, { session }).toArray();
  const byId = new Map(rows.map((row) => [String(row._id), row]));
  const records = [];
  for (const { recordId, revision } of refs) {
    const row = byId.get(String(recordId));
    const entry = row?.revisions?.find((value) => value.revision === revision && value.reviewStatus === "approved");
    if (!entry) continue;
    const current = row.currentRevision == null ? entry :
      row.revisions.find((value) => value.revision === row.currentRevision);
    const excluded = isClaim(row) && (!canReuseClaim(entry, now) ||
      claimPermission(current?.usagePermission) !== "public" ||
      ["disputed", "expired", "rejected"].includes(current?.reviewStatus));
    records.push({ excluded,
      expired: entry.reviewDueAt != null && !(new Date(entry.reviewDueAt) > now),
      data: { ...entry, recordId: row._id, area: row.area, recordType: row.recordType },
    });
  }
  return { version, records, missing: records.length !== refs.length };
}

export function assessReadiness(snapshot, { agentKey, brief, requireBrief = false } = {}) {
  const applicable = snapshot.records.filter(({ data }) => !data.agentKey || data.agentKey === agentKey);
  const knowledge = applicable.filter(({ expired, excluded }) => !expired && !excluded).map(({ data }) => data);
  const reason = requireBrief && brief?.validated !== true ? "Save a validated Excel brief before starting the run."
    : !snapshot.version ? "Publish the brand's knowledge before starting the run."
    : snapshot.missing ? "A published knowledge revision is unavailable."
    : !knowledge.length ? "No current published knowledge applies to this scope."
    : applicable.some(({ excluded }) => excluded) ? "Published claims without current permission or evidence were excluded."
    : knowledge.length < applicable.length ? "Some published knowledge has expired and was excluded." : null;
  const blocked = (requireBrief && brief?.validated !== true) || !snapshot.version || snapshot.missing || !knowledge.length;
  const verdict = blocked ? "BLOCKED" : reason ? "LIMITED" : "READY";
  return { knowledge, readiness: { verdict, band: verdict, blocked, canStart: !blocked, reason,
    limitations: verdict === "LIMITED" ? [reason] : [] } };
}

export function mergeReadiness(readiness, verdict, reason) {
  if (readiness.blocked || !["LIMITED", "BLOCKED"].includes(verdict) || readiness.verdict === verdict) return readiness;
  const blocked = verdict === "BLOCKED";
  return { verdict, band: verdict, blocked, canStart: !blocked, reason,
    limitations: blocked ? [] : [reason] };
}

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
    if (user.status !== "active") return res.sendStatus(403);
    const clientId = parseId(req.params.clientId);
    if (!clientId) return res.sendStatus(400);
    const brand = await brands.findOne({ _id: clientId });
    if (!brand) return res.sendStatus(404);
    const role = (...roles) => hasClientRole(user, String(clientId), roles);
    const admin = isPlatformAdmin(user);
    if (!admin && !role("brand_manager", "approver", "operator", "viewer"))
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
    // Brand settings: Platform Admin and every Brand Manager of this brand.
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
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

  // ---- Brand people: Platform Admin and the brand's Brand Managers manage who
  // has which role on THIS brand. Platform-wide access stays in /api/auth/user-access.
  const memberRow = (member, clientId) => ({
    id: String(member._id), email: member.email, name: member.name ?? member.email, status: member.status,
    platformAdmin: member.globalRoles?.includes("platform_admin") === true,
    roles: (member.clientAssignments ?? []).filter((entry) => String(entry.clientId) === String(clientId))
      .flatMap(({ roles }) => roles),
  });

  router.get(brandPath + "/members", scope, async (req, res) => {
    const { clientId, admin, role } = res.locals.brandScope;
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
    const members = await db.collection("users").find(
      { "clientAssignments.clientId": idFilter(clientId) }, { projection: { googleSub: 0 } },
    ).sort({ email: 1 }).toArray();
    res.json({ members: members.map((member) => memberRow(member, clientId)) });
  });

  router.put(brandPath + "/members", scope, async (req, res) => {
    const { user, clientId, brand, admin, role } = res.locals.brandScope;
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
    if (brand.status === "archived") return res.sendStatus(409);
    const email = cleanText(req.body?.email).toLowerCase();
    const roles = req.body?.roles;
    if (!brandEmail.test(email) || !Array.isArray(roles) || roles.length > brandRoles.length ||
        !roles.every((value) => brandRoles.includes(value))) return res.sendStatus(400);
    const nextRoles = [...new Set(roles)];
    const users = db.collection("users");
    const result = await mongo.withSession((session) => session.withTransaction(async () => {
      const target = await users.findOne({ email }, { session });
      if (target?._id.equals(user._id)) return { status: 403, message: "You can't change your own roles." };
      if (target?.globalRoles?.includes("platform_admin"))
        return { status: 409, message: "Platform Admins already have access to every brand." };
      if (target && ["suspended", "deactivated"].includes(target.status))
        return { status: 409, message: "This person's account is suspended. Ask a Platform Admin." };
      const assigned = target?.clientAssignments ?? [];
      const previous = assigned.find((entry) => String(entry.clientId) === String(clientId));
      if (!target && !nextRoles.length) return { status: 404 };
      const namedApprover = target && [brand.defaultApproverUserId, brand.backupApproverUserId]
        .some((id) => id && String(id) === String(target._id));
      if (namedApprover && !nextRoles.includes("approver"))
        return { status: 409, message: "This person is a named approver. Pick another approver in brand settings first." };
      const now = new Date();
      const others = assigned.filter((entry) => String(entry.clientId) !== String(clientId));
      const clientAssignments = nextRoles.length ? [...others, {
        clientId: String(clientId), roles: nextRoles, assignedByUserId: user._id, assignedAt: now,
      }] : others;
      let saved;
      if (target) {
        const status = clientAssignments.length ? (target.status === "pending" ? "active" : target.status) : "pending";
        saved = await users.findOneAndUpdate({ _id: target._id, updatedAt: target.updatedAt ?? null },
          { $set: { clientAssignments, status, updatedAt: now } },
          { session, returnDocument: "after", projection: { googleSub: 0 } });
        if (!saved) return { status: 409, message: "This person's access just changed. Reload and try again." };
      } else {
        saved = {
          _id: new ObjectId(), googleSub: null, email, name: email, status: "active", globalRoles: [],
          clientAssignments, accessRequestedAt: null, accessRequestNote: null, accessRequestNoteAt: null,
          createdAt: now, updatedAt: now,
        };
        await users.insertOne(saved, { session });
      }
      await db.collection("audit_events").insertOne({
        clientId, eventType: "user_access_changed", outcome: "success", actorUserId: user._id,
        targetUserId: saved._id, occurredAt: now,
        details: { action: "brand_roles", before: previous?.roles ?? [], after: nextRoles },
      }, { session });
      return { status: 200, member: memberRow(saved, clientId) };
    }));
    if (result.status !== 200) return result.message
      ? res.status(result.status).json({ message: result.message }) : res.sendStatus(result.status);
    res.json({ member: result.member });
  });

  router.get(brandPath + "/knowledge/readiness", scope, async (req, res) => {
    const { brand } = res.locals.brandScope;
    const snapshot = await resolvePublishedKnowledge(db, brand);
    const { readiness } = assessReadiness(snapshot);
    const keys = (brand.agents ?? []).filter(({ enabled }) => enabled === true).map(({ agentKey }) => agentKey);
    const live = keys.length ? await agents.find({ agentKey: { $in: keys }, releaseStatus: "live" })
      .project({ agentKey: 1 }).toArray() : [];
    const perAgent = Object.fromEntries(live.map(({ agentKey }) => [
      agentKey, assessReadiness(snapshot, { agentKey }).readiness,
    ]));
    res.json({ readiness: { ...readiness, perAgent }, version: snapshot.version?.version ?? null });
  });

  router.get(brandPath + "/knowledge/sources", scope, async (req, res) => {
    const { clientId, admin, role } = res.locals.brandScope;
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
    const filter = { clientId };
    const [active, legacy] = await Promise.all([
      sources.find(filter).toArray(), db.collection("knowledgeSource").find(filter).toArray(),
    ]);
    const known = new Set(active.map(({ _id }) => String(_id)));
    res.json({ knowledgeSources: [...active, ...legacy.filter(({ _id }) => !known.has(String(_id)))
      .map(({ area, ...source }) => ({ ...source, areas: source.areas ?? (area ? [area] : []) }))] });
  });

  router.post(brandPath + "/knowledge/files/:filename", scope, (req, res, next) => {
    const { admin, role, brand } = res.locals.brandScope;
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
    if (brand.status === "archived") return res.sendStatus(409);
    if (!knowledgeAreas.has(req.params.filename) || !req.is("application/octet-stream"))
      return res.status(400).json({ message: "Choose one of the five knowledge Markdown files." });
    next();
  }, express.raw({ type: "application/octet-stream", limit: "1mb" }), async (req, res) => {
    const { filename } = req.params;
    const { user, clientId } = res.locals.brandScope;
    if (!Buffer.isBuffer(req.body))
      return res.status(400).json({ message: "Choose a non-empty Markdown file." });
    let markdown;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(req.body);
    } catch {
      return res.status(400).json({ message: "Save this Markdown file as UTF-8." });
    }
    if (!markdown.trim() || markdown.includes("\0"))
      return res.status(400).json({ message: "Choose a non-empty Markdown text file." });

    const digest = createHash("sha256").update(req.body).digest("hex");
    const key = createHash("sha256").update(String(clientId) + "/" + filename + "/" + digest).digest("hex");
    const _id = new ObjectId(key.slice(0, 24));
    const files = db.collection("knowledgeFiles");
    const now = new Date();
    const source = {
      _id, clientId, sourceType: "file", title: filename, areas: knowledgeAreas.get(filename),
      fileRef: "knowledgeFiles/" + _id, storedFile: true, processingStatus: "pending",
      uploadedByUserId: user._id, createdAt: now, updatedAt: now,
    };
    try {
      const saved = await mongo.withSession((session) => session.withTransaction(async () => {
        const existing = await sources.findOne({ _id, clientId }, { session });
        if (existing) return existing;
        await files.insertOne({ _id, clientId, filename, digest, bytes: req.body, createdAt: now }, { session });
        await sources.insertOne(source, { session });
        await audit(user, clientId, "knowledge_source_added", _id, { filename }, session);
        return source;
      }));
      res.json({ source: saved });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existing = await sources.findOne({ _id, clientId, fileRef: source.fileRef });
      if (!existing) throw error;
      res.json({ source: existing });
    }
  });

  router.post(brandPath + "/knowledge/sources", scope, async (req, res) => {
    const { user, role, admin, clientId, brand } = res.locals.brandScope;
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
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

  const readUpload = raw({ type: "multipart/form-data", limit: maxKnowledgeFileBytes + 64 * 1024 });
  router.post(brandPath + "/knowledge/sources/upload", scope, (req, res, next) => {
    const { role, admin, brand } = res.locals.brandScope;
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
    if (brand.status === "archived") return res.sendStatus(409);
    if (!req.is("multipart/form-data"))
      return res.status(415).json({ message: "Send the file as multipart form data." });
    readUpload(req, res, (error) => {
      if (error?.status === 413)
        return res.status(413).json({ message: "Choose a knowledge file no larger than 2 MiB." });
      next(error);
    });
  }, async (req, res) => {
    const { user, clientId } = res.locals.brandScope;
    let form;
    try {
      form = await new Response(req.body, {
        headers: { "Content-Type": req.get("content-type") },
      }).formData();
    } catch {
      return res.status(400).json({ message: "Could not read the upload. Choose one file and try again." });
    }
    const file = form.get("file");
    const fileCount = [...form.values()].filter((value) => typeof value !== "string").length;
    const areas = [...new Set(form.getAll("areas").map(cleanText).filter(Boolean))];
    if (fileCount !== 1 || typeof file === "string" || !file?.size ||
        !areas.length || areas.length > 20 || areas.some((area) => area.length > 100))
      return res.status(400).json({ message: "Choose one non-empty file and at least one knowledge area." });
    if (file.size > maxKnowledgeFileBytes)
      return res.status(413).json({ message: "Choose a knowledge file no larger than 2 MiB." });
    const title = file.name.trim();
    const extension = extname(title).toLowerCase();
    if (title.length > 255 || /[/\\\x00-\x1f]/.test(title) || !knowledgeFileTypes.has(extension))
      return res.status(415).json({ message: "Choose a supported knowledge file." });

    const bytes = Buffer.from(await file.arrayBuffer());
    let statement;
    if (extension === ".md") {
      try {
        statement = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      } catch {
        return res.status(400).json({ message: "Save the Markdown file as UTF-8 and try again." });
      }
      if (!statement || statement.includes("\0"))
        return res.status(400).json({ message: "Add readable text to the Markdown file." });
    }

    const now = new Date();
    const fileId = new ObjectId();
    const source = {
      _id: new ObjectId(), clientId, sourceType: "file", title, areas,
      fileRef: String(fileId), processingStatus: statement ? "completed" : "pending",
      uploadedByUserId: user._id, createdAt: now, updatedAt: now,
    };
    const record = statement ? {
      _id: new ObjectId(), clientId, sourceId: source._id, area: areas[0], recordType: "document",
      currentRevision: 1, revisions: [{ revision: 1, statement, agentKey: null, reviewStatus: "needs_review" }],
      createdAt: now, updatedAt: now,
    } : null;
    const bucket = new GridFSBucket(db, { bucketName: "knowledgeFiles" });
    try {
      const upload = bucket.openUploadStreamWithId(fileId, title, { metadata: { clientId, sourceId: source._id } });
      const uploaded = finished(upload);
      upload.end(bytes);
      await uploaded;
      await mongo.withSession((session) => session.withTransaction(async () => {
        await sources.insertOne(source, { session });
        if (record) await records.insertOne(record, { session });
        await audit(user, clientId, "knowledge_source_added", source._id, {}, session);
        if (record) await audit(user, clientId, "knowledge_record_created", record._id, {}, session);
      }));
    } catch (error) {
      // An uncertain commit could still reference the file.
      if (!error.hasErrorLabel?.("UnknownTransactionCommitResult")) {
        try { await bucket.delete(fileId); }
        catch (cleanupError) {
          if (cleanupError.code !== "ENOENT" && !cleanupError.message?.startsWith("File not found"))
            console.error("Knowledge upload cleanup failed", cleanupError.name);
        }
      }
      throw error;
    }
    res.status(201).json({ source, record });
  });

  router.get(brandPath + "/knowledge/records", scope, async (req, res) => {
    const { clientId, role, admin } = res.locals.brandScope;
    if (!admin && !role("brand_manager", "approver", "operator", "viewer")) return res.sendStatus(403);
    const filter = { clientId };
    for (const key of ["area", "recordType"]) {
      if (typeof req.query[key] === "string") filter[key] = req.query[key];
    }
    const rows = await records.find(filter).sort({ updatedAt: -1 }).toArray();
    if (admin || role("brand_manager")) return res.json({ knowledgeRecords: rows });
    res.json({ knowledgeRecords: rows.flatMap((record) => {
      const revision = record.revisions.find((entry) => entry.revision === record.currentRevision);
      return revision?.reviewStatus === "approved" ? [{ ...record, revisions: [revision] }] : [];
    }) });
  });

  router.post(brandPath + "/knowledge/records", scope, async (req, res) => {
    const { clientId, role, user, brand, admin } = res.locals.brandScope;
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
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
    const { clientId, role, user, brand, admin } = res.locals.brandScope;
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
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
    if (isClaim(existing) && Object.hasOwn(changes, "usagePermission")) {
      const permission = claimPermission(changes.usagePermission);
      if (permission && !claimPermissions.has(permission))
        return res.status(422).json({ message: "Use Public, Restricted or Internal only for claim reuse permission." });
      changes.usagePermission = permission;
    }
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
    const { user, clientId, role, brand, admin } = res.locals.brandScope;
    if (!admin && !role("brand_manager")) return res.sendStatus(403);
    if (brand.status === "archived") return res.sendStatus(409);
    const now = new Date();
    const published = await mongo.withSession((session) => session.withTransaction(async () => {
      const versionId = new ObjectId();
      const approvedRecords = (await records.aggregate([
        { $match: { clientId } }, { $unwind: "$revisions" },
        { $match: { $expr: { $eq: ["$currentRevision", "$revisions.revision"] },
          "revisions.reviewStatus": "approved", "revisions.evidenceGrade": { $in: ["A", "B", "C"] },
          $or: [{ "revisions.reviewDueAt": null }, { "revisions.reviewDueAt": { $gt: now } }] } },
        { $project: { revision: "$currentRevision", area: 1, recordType: 1, data: "$revisions" } },
      ], { session }).toArray()).filter((record) => !isClaim(record) || canReuseClaim(record.data, now));
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
    res.json({ agents: rows, skills: skillStatus(), openai: modelStatus() });
  });
}
