import { ObjectId } from "mongodb";
import { callSkill } from "./qualification-skills.js";
import { parseId, cleanText, idFilter } from "./brand-routes.js";

const clientRoles = ["knowledge_admin", "marketing_operator", "approver", "viewer"];
const objectId = parseId;

export function registerWorkflowRoutes(router, { db, mongo, current, isPlatformAdmin, hasClientRole, recentStepUp }) {
  const projectPath = "/workflow/projects/:projectId";
  const projectScope = async (req, res, next) => {
    const { user } = await current(req);
    if (!user) return res.sendStatus(401);
    if (user.status !== "active") return res.sendStatus(403);
    const projectId = objectId(req.params.projectId);
    if (!projectId) return res.status(400).json({ message: "Select a valid project." });
    const project = await db.collection("projects").findOne({ _id: projectId });
    if (!project) return res.sendStatus(404);
    const clientId = String(project.clientId);
    if (!isPlatformAdmin(user) && !hasClientRole(user, clientId, clientRoles))
      return res.sendStatus(403);
    const brandId = objectId(clientId);
    const brand = brandId && await db.collection("brands").findOne({ _id: brandId });
    res.locals.workflow = { scope: { clientId: project.clientId, projectId }, user, project, brand };
    next();
  };

  const runs = db.collection("runs");
  const items = db.collection("contentItems");
  const drafts = db.collection("draftVersions");
  const decisions = db.collection("reviewDecisions");

  function canEdit(user, scope, run) {
    return hasClientRole(user, String(scope.clientId), ["approver"]) ||
      (String(run.ownerUserId) === String(user._id) &&
        hasClientRole(user, String(scope.clientId), ["marketing_operator"]));
  }

  const writeAudit = (scope, user, eventType, targetType, targetId, details, session) =>
    db.collection("audit_events").insertOne({
      clientId: scope.clientId, actorUserId: user._id, eventType, outcome: "success",
      targetType, targetId, details, occurredAt: new Date(),
    }, { session });

  router.get("/workflow/approvals", async (req, res) => {
    const { user } = await current(req);
    if (!user) return res.sendStatus(401);
    if (user.status !== "active") return res.sendStatus(403);
    const allowed = (user.clientAssignments ?? []).filter(({ clientId }) =>
      hasClientRole(user, String(clientId), ["marketing_operator", "approver"]));
    const ids = allowed.flatMap(({ clientId }) => [String(clientId), objectId(String(clientId))].filter(Boolean));
    const reviewDecisions = await decisions.find({
      clientId: { $in: ids }, assignedReviewerId: user._id, status: "pending",
    }).sort({ dueAt: 1, requestedAt: 1 }).toArray();
    res.json({ reviewDecisions });
  });

  router.post(projectPath + "/runs/:recordId/plan-review", projectScope, async (req, res) => {
    const { user, scope, brand } = res.locals.workflow;
    const _id = objectId(req.params.recordId);
    const { planVersion, selectedPlanItemIds, askApprover = false } = req.body ?? {};
    if (!_id || !Number.isSafeInteger(planVersion) || planVersion < 1 ||
        typeof askApprover !== "boolean" || !Array.isArray(selectedPlanItemIds) || !selectedPlanItemIds.length ||
        selectedPlanItemIds.some((id) => !objectId(id))) return res.sendStatus(400);
    if (brand?.status === "archived") return res.sendStatus(409);
    const run = await runs.findOne({ ...scope, _id });
    if (!run) return res.sendStatus(404);
    if (String(run.ownerUserId) !== String(user._id) || !canEdit(user, scope, run))
      return res.sendStatus(403);
    const plan = run.planRevisions?.at(-1);
    const selected = [...new Set(selectedPlanItemIds.map((id) => id.toLowerCase()))];
    if (run.currentStageKey !== "gate_1" || plan?.version !== planVersion ||
        selected.some((id) => !plan.items?.some((item) => String(item.itemId) === id))) return res.sendStatus(409);
    const approvals = [{ reviewType: "owner", assignedReviewerId: user._id }];
    if (askApprover) {
      const approver = brand?.defaultApproverUserId && await db.collection("users")
        .findOne({ _id: brand.defaultApproverUserId });
      if (!approver || String(approver._id) === String(user._id) ||
          !hasClientRole(approver, String(scope.clientId), ["approver"])) return res.sendStatus(422);
      approvals.push({ reviewType: "requested_approver", assignedReviewerId: approver._id });
    }
    const now = new Date();
    const rows = approvals.map((approval) => ({
      ...scope, ...approval, _id: new ObjectId(), runId: _id, gate: "gate_1", status: "pending",
      requestedAt: now, planVersion, selectedPlanItemIds: selected.map(objectId),
    }));
    const saved = await mongo.withSession((session) => session.withTransaction(async () => {
      const existing = await decisions.findOne({
        ...scope, runId: _id, gate: "gate_1", planVersion, status: { $in: ["pending", "decided"] },
      }, { session });
      if (existing) return false;
      const locked = await runs.updateOne({
        ...scope, _id, currentStageKey: "gate_1", status: run.status,
        planRevisions: run.planRevisions,
      }, { $set: { status: "awaiting_plan_approval" } }, { session });
      if (!locked.matchedCount) return false;
      await decisions.insertMany(rows, { session });
      await writeAudit(scope, user, "gate_1_requested", "run", _id, { planVersion }, session);
      return true;
    }));
    if (!saved) return res.sendStatus(409);
    res.status(201).json({ reviewDecisions: rows });
  });

  router.post(projectPath + "/reviews/:recordId/decision", projectScope, async (req, res) => {
    const { user, scope, brand } = res.locals.workflow;
    const _id = objectId(req.params.recordId);
    const { decision } = req.body ?? {};
    const reason = cleanText(req.body?.reason);
    if (!_id || !["approved", "changes_requested", "rejected"].includes(decision) ||
        (decision !== "approved" && !reason)) return res.sendStatus(400);
    if (brand?.status === "archived") return res.sendStatus(409);
    const review = await decisions.findOne({ ...scope, _id, assignedReviewerId: user._id });
    if (!review) return res.sendStatus(404);
    const run = await runs.findOne({ ...scope, _id: review.runId });
    if (!run || review.status !== "pending" || ["cancelled", "failed", "completed"].includes(run.status))
      return res.sendStatus(409);
    const owner = String(run.ownerUserId) === String(user._id);
    const approver = hasClientRole(user, String(scope.clientId), ["approver"]);
    if (review.gate === "gate_2") {
      if (!approver || owner) return res.sendStatus(403);
      const { session } = await current(req);
      if (!session || !recentStepUp(session))
        return res.status(403).json({ code: "reauthentication_required" });
    } else if (review.gate === "gate_1") {
      const allowed = review.reviewType === "owner" ? owner && canEdit(user, scope, run)
        : review.reviewType === "requested_approver" && approver;
      if (!allowed) return res.sendStatus(403);
    } else {
      return res.sendStatus(409);
    }
    const now = new Date();
    const saved = await mongo.withSession((session) => session.withTransaction(async () => {
      const target = await runs.findOne({ ...scope, _id: review.runId, status: run.status }, { session });
      if (!target) return null;
      const filter = { ...scope, _id, status: "pending", assignedReviewerId: user._id };
      if (review.gate === "gate_1") {
        if (target.planRevisions?.at(-1)?.version !== review.planVersion) return null;
        const locked = await runs.updateOne({ ...scope, _id: target._id, status: target.status },
          { $set: { currentStageKey: target.currentStageKey ?? "gate_1" } }, { session });
        if (!locked.matchedCount) return null;
      } else {
        const post = await items.findOne({
          ...scope, _id: review.contentItemId, runId: target._id, currentDraftVersionId: review.draftVersionId,
        }, { session });
        if (!post || ["publishing", "published", "cancelled"].includes(post.status)) return null;
        if (decision === "approved" && (!review.destination ||
          (review.scheduledAt != null && (!(review.scheduledAt instanceof Date) || review.scheduledAt <= now))))
          return null;
        const change = decision === "approved" ? {
          status: "approved", approvedDraftVersionId: review.draftVersionId,
          "publishing.destination": review.destination, "publishing.scheduledAt": review.scheduledAt ?? null,
        } : { status: "changes_requested" };
        await items.updateOne({ ...scope, _id: post._id }, { $set: change }, { session });
      }
      const result = await decisions.findOneAndUpdate(filter, {
        $set: { status: "decided", decision, reason, decidedByUserId: user._id, decidedAt: now },
      }, { session, returnDocument: "after" });
      if (!result) throw new Error("Approval decision changed during the transaction.");
      if (review.gate === "gate_1") {
        const otherReviews = await decisions.find({
          ...scope, runId: target._id, gate: "gate_1", planVersion: review.planVersion, _id: { $ne: _id },
        }, { session }).toArray();
        if (decision !== "approved" || otherReviews.every((entry) => entry.decision === "approved")) {
          await runs.updateOne({ ...scope, _id: target._id }, {
            $set: { status: decision === "approved" ? "plan_approved" : "plan_changes_requested" },
          }, { session });
        }
      }
      await writeAudit(scope, user, review.gate + "_decided", "reviewDecision", _id, { decision, reason }, session);
      return result;
    }));
    if (!saved) return res.sendStatus(409);
    res.json({ reviewDecision: saved });
  });

  router.post(projectPath + "/runs/:recordId/cancel", projectScope, async (req, res) => {
    const { user, scope } = res.locals.workflow;
    const _id = objectId(req.params.recordId);
    if (!_id) return res.sendStatus(400);
    const run = await runs.findOne({ ...scope, _id });
    if (!run) return res.sendStatus(404);
    if (!isPlatformAdmin(user) && !canEdit(user, scope, run)) return res.sendStatus(403);
    const now = new Date();
    const saved = await mongo.withSession((session) => session.withTransaction(async () => {
      const result = await runs.findOneAndUpdate({
        ...scope, _id, status: { $nin: ["cancelled", "completed", "failed", "publishing"] },
      }, { $set: { status: "cancelled", finishedAt: now } }, { session, returnDocument: "after" });
      if (!result) return null;
      await decisions.updateMany({ ...scope, runId: _id, status: "pending" }, {
        $set: { status: "invalidated", invalidatedAt: now, invalidationReason: "run_cancelled" },
      }, { session });
      await writeAudit(scope, user, "run_cancelled", "run", _id, {}, session);
      return result;
    }));
    if (!saved) return res.sendStatus(409);
    res.json({ run: saved });
  });

  router.post(projectPath + "/posts/:recordId/drafts", projectScope, async (req, res) => {
    const { user, scope, brand } = res.locals.workflow;
    const _id = objectId(req.params.recordId);
    const currentId = objectId(req.body?.currentDraftVersionId);
    const text = cleanText(req.body?.text);
    if (!_id || !currentId || !text) return res.sendStatus(400);
    if (brand?.status === "archived") return res.sendStatus(409);
    const post = await items.findOne({ ...scope, _id });
    if (!post) return res.sendStatus(404);
    const run = await runs.findOne({ ...scope, _id: post.runId });
    if (!run || !canEdit(user, scope, run)) return res.sendStatus(403);
    if (["cancelled", "completed", "failed"].includes(run.status)) return res.sendStatus(409);
    const previous = await drafts.findOne({ ...scope, _id: currentId, contentItemId: _id });
    if (!previous) return res.sendStatus(409);
    const now = new Date();
    const draft = {
      ...scope, _id: new ObjectId(), contentItemId: _id, version: previous.version + 1,
      text, qaChecks: [], claims: [], comments: [], createdByUserId: user._id, createdAt: now,
      changeSummary: cleanText(req.body?.changeSummary),
    };
    const saved = await mongo.withSession((session) => session.withTransaction(async () => {
      const updated = await items.updateOne({
        ...scope, _id, currentDraftVersionId: currentId, status: { $nin: ["publishing", "published", "cancelled"] },
        "publishing.attempts.0": { $exists: false },
      }, {
        $set: { currentDraftVersionId: draft._id, status: "draft" },
        $unset: { approvedDraftVersionId: "", approvedFileRef: "" },
      }, { session });
      if (!updated.matchedCount) return false;
      await drafts.insertOne(draft, { session });
      await decisions.updateMany({
        ...scope, contentItemId: _id, draftVersionId: currentId, gate: "gate_2",
        invalidatedAt: null, $or: [{ status: "pending" }, { decision: "approved" }],
      }, { $set: { status: "invalidated", invalidatedAt: now, invalidationReason: "draft_changed" } }, { session });
      await writeAudit(scope, user, "draft_revised", "contentItem", _id, { draftVersionId: draft._id }, session);
      return true;
    }));
    if (!saved) return res.sendStatus(409);
    res.status(201).json({ draft });
  });

  router.get("/workflow/clients/:clientId/projects", async (req, res) => {
    const { user } = await current(req);
    if (!user) return res.sendStatus(401);
    const clientId = req.params.clientId;
    if (!isPlatformAdmin(user) && !hasClientRole(user, clientId, clientRoles))
      return res.sendStatus(403);
    const ids = [clientId, objectId(clientId)].filter(Boolean);
    const projects = await db.collection("projects").find({ clientId: { $in: ids } })
      .project({ name: 1, clientId: 1, channels: 1, status: 1 }).sort({ name: 1 }).toArray();
    res.json({ projects });
  });

  for (const [path, collection] of [
    ["briefs", "briefs"], ["runs", "runs"], ["posts", "contentItems"],
  ]) {
    router.get(projectPath + "/" + path, projectScope, async (req, res) => {
      const { scope } = res.locals.workflow;
      const records = await db.collection(collection).find(scope).sort({ _id: -1 }).toArray();
      res.json({ [collection]: records });
    });
  }

  router.get(projectPath + "/knowledge", projectScope, async (req, res) => {
    const { scope, user } = res.locals.workflow;
    const clientId = String(scope.clientId);
    if (!isPlatformAdmin(user) && !hasClientRole(user, clientId, clientRoles.slice(0, 3)))
      return res.sendStatus(403);
    const filter = isPlatformAdmin(user) || hasClientRole(user, clientId, ["knowledge_admin"])
      ? scope : { ...scope, status: { $in: ["approved", "published"] } };
    const knowledgeVersions = await db.collection("knowledgeVersions").find(filter)
      .sort({ _id: -1 }).toArray();
    res.json({ knowledgeVersions });
  });

  router.post(projectPath + "/runs/drafts", projectScope, async (req, res) => {
    const { scope, user, project, brand } = res.locals.workflow;
    if (!hasClientRole(user, String(scope.clientId), ["marketing_operator", "approver"]))
      return res.sendStatus(403);
    if (project.status !== "active" || brand?.status !== "active")
      return res.status(409).json({ message: "Select an active brand and project." });
    const briefId = objectId(req.body?.briefId);
    const briefVersion = req.body?.briefVersion;
    if (!briefId || !Number.isSafeInteger(briefVersion) || briefVersion < 1)
      return res.status(400).json({ message: "Save the brief before creating a draft." });
    const brief = await db.collection("briefs").findOne({ ...scope, _id: briefId,
      versions: { $elemMatch: { version: briefVersion } } });
    if (!brief) return res.status(404).json({ message: "The saved brief version is unavailable." });
    const version = brief.versions.find((entry) => entry.version === briefVersion);
    const filter = { ...scope, briefId, briefVersion, ownerUserId: user._id, status: "draft" };
    const run = await runs.findOneAndUpdate(filter, { $setOnInsert: {
      title: brief.title, period: version.period, createdAt: new Date(),
      ...(brief.agentId ? { agentId: brief.agentId } : {}),
    } }, { upsert: true, returnDocument: "after" });
    return res.status(201).json({ run });
  });

  router.post(projectPath + "/briefs", projectScope, async (req, res) => {
    const { scope, user, project } = res.locals.workflow;
    if (!hasClientRole(user, String(scope.clientId), ["marketing_operator", "approver"]))
      return res.sendStatus(403);
    if (project.status !== "active" || res.locals.workflow.brand?.status === "archived")
      return res.status(409).json({ message: "This project is inactive." });
    const { title, briefId, currentVersion, period, objective, audience, deliverables, kpi,
      agentId: agentKey, fileRef, templateVersion, keyDates, blackoutDays, postingSlots, excelFields } = req.body ?? {};
    if (!cleanText(title) || !cleanText(period) || !cleanText(objective) || !cleanText(audience) ||
        deliverables == null || kpi == null)
      return res.status(400).json({ message: "Complete the brief title, period, objective, audience, deliverables and KPI." });
    const agentId = agentKey === undefined ? null : objectId(agentKey);
    if (agentKey !== undefined && !agentId) return res.sendStatus(400);
    if (agentId) {
      const agent = await db.collection("agents").findOne({ _id: agentId, releaseStatus: "live" });
      if (!agent || !res.locals.workflow.brand?.agents?.some(
        (configuration) => configuration.agentKey === agent.agentKey && configuration.enabled === true,
      )) return res.sendStatus(422);
    }
    const version = { period, objective, audience, deliverables, kpi,
      savedBy: user._id, savedAt: new Date() };
    if (excelFields !== undefined) {
      if (!excelFields || typeof excelFields !== "object" || Array.isArray(excelFields) ||
          Object.entries(excelFields).some(([key, value]) => !cleanText(key) ||
            !["string", "number", "boolean"].includes(typeof value)) ||
          !Number.isInteger(deliverables) || deliverables < 1 || deliverables > 40 || !cleanText(kpi))
        return res.status(400).json({ message: "Provide valid Excel fields, a post count from 1 to 40 and a primary KPI." });
      version.excelFields = excelFields;
    }
    for (const [key, value] of Object.entries({ fileRef, templateVersion })) {
      if (value === undefined) continue;
      if (!cleanText(value)) return res.sendStatus(400);
      version[key] = value.trim();
    }
    for (const [key, dates] of Object.entries({ keyDates, blackoutDays })) {
      if (dates === undefined) continue;
      if (!Array.isArray(dates) || dates.some((date) => typeof date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().slice(0, 10) !== date)) return res.sendStatus(400);
      version[key] = dates;
    }
    if (postingSlots !== undefined) {
      if (!Array.isArray(postingSlots) || postingSlots.some((slot) =>
        typeof slot !== "string" || !Number.isFinite(Date.parse(slot)))) return res.sendStatus(400);
      version.postingSlots = postingSlots.map((slot) => new Date(slot));
    }
    const briefs = db.collection("briefs");
    if (briefId === undefined) {
      const brief = { ...scope, ...(agentId ? { agentId } : {}),
        title: title.trim(), currentVersion: 1, versions: [{ version: 1, ...version }] };
      const { insertedId } = await briefs.insertOne(brief);
      return res.status(201).json({ brief: { ...brief, _id: insertedId } });
    }
    const id = objectId(briefId);
    if (!id || !Number.isSafeInteger(currentVersion) || currentVersion < 1)
      return res.status(400).json({ message: "Select the brief and its current revision." });
    const filter = agentId ? { $or: [{ agentId }, { agentId: { $exists: false } }] } : {};
    const brief = await briefs.findOneAndUpdate({ ...scope, ...filter, _id: id, currentVersion }, {
      $set: { title: title.trim(), ...(agentId ? { agentId } : {}) }, $inc: { currentVersion: 1 },
      $push: { versions: { version: currentVersion + 1, ...version } },
    }, { returnDocument: "after" });
    if (!brief) return res.status(409).json({ message: "The brief changed. Reload it before saving again." });
    res.json({ brief });
  });

  router.post(projectPath + "/runs", projectScope, async (req, res) => {
    const { user, scope, brand, project } = res.locals.workflow;
    if (!hasClientRole(user, String(scope.clientId), ["marketing_operator", "approver"]))
      return res.sendStatus(403);
    if (project.status !== "active" || !brand || brand.status === "archived")
      return res.status(409).json({ message: "This project is inactive." });
    const briefId = objectId(req.body?.briefId);
    const currentVersion = req.body?.currentVersion;
    if (!briefId || !Number.isSafeInteger(currentVersion) || currentVersion < 1) return res.sendStatus(400);
    const brief = await db.collection("briefs").findOne({ ...scope, _id: briefId });
    if (!brief) return res.sendStatus(404);
    if (brief.currentVersion !== currentVersion)
      return res.status(409).json({ message: "The brief changed. Validate the latest revision before starting." });
    const version = brief.versions?.find((entry) => entry.version === currentVersion);
    if (!version?.excelFields && !version?.validated)
      return res.status(422).json({ message: "Upload and validate an Excel brief before starting." });

    const config = {
      key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL,
      "context-assembler": { id: process.env.B2B_CONTEXT_SKILL_ID, version: process.env.B2B_CONTEXT_SKILL_VERSION },
      "brief-qualifier": { id: process.env.B2B_QUALIFIER_SKILL_ID, version: process.env.B2B_QUALIFIER_SKILL_VERSION },
    };
    if (!config.key || !config.model || !["context-assembler", "brief-qualifier"].every(
      (stage) => config[stage].id && config[stage].version,
    )) return res.status(503).json({ message: "Configure both qualification skills on the backend before starting a run." });

    const knowledgeVersions = db.collection("knowledgeVersions");
    const [projectKnowledge, published] = await Promise.all([
      knowledgeVersions.find({ ...scope, status: { $in: ["approved", "published"] } })
        .sort({ version: -1 }).toArray(),
      brand.publishedKnowledgeVersionId && knowledgeVersions.findOne({
        _id: brand.publishedKnowledgeVersionId, clientId: idFilter(brand._id), status: "published",
      }),
    ]);
    const approved = new Map();
    for (const entry of projectKnowledge) {
      const key = entry.recordKey ?? String(entry._id);
      if (!approved.has(key)) approved.set(key, { recordKey: entry.recordKey, version: entry.version, data: entry.data });
    }
    const ids = published?.recordRevisions ?? [];
    const records = ids.length ? await db.collection("knowledgeRecords")
      .find({ clientId: brand._id, _id: { $in: ids.map(({ recordId }) => recordId) } }).toArray() : [];
    const knowledge = [...approved.values(), ...records.flatMap((record) => {
      const pinned = ids.find(({ recordId }) => String(recordId) === String(record._id));
      const revision = record.revisions?.find((entry) => entry.revision === pinned?.revision);
      return revision ? [{ area: record.area, recordType: record.recordType, ...revision }] : [];
    })];

    const stages = db.collection("stageExecutions");
    const record = {
      ...scope, _id: new ObjectId(), title: brief.title, period: version.period,
      ...(brief.agentId ? { agentId: brief.agentId } : {}),
      briefId, briefVersion: currentVersion, ownerUserId: user._id, ownerEmail: user.email,
      ...(published && { knowledgeVersionId: published._id }),
      projectKnowledgeVersionIds: projectKnowledge.map(({ _id }) => _id),
      status: "running", currentStageKey: "brief-qualifier", startedAt: new Date(),
    };
    await mongo.withSession((session) => session.withTransaction(async () => {
      await runs.insertOne(record, { session });
      await writeAudit(scope, user, "run_started", "run", record._id, { briefId, currentVersion }, session);
    }));

    const qualificationResult = {};
    const stageExecutions = [];
    const signal = AbortSignal.timeout(650_000);
    const persistStage = async (stageKey, input) => {
      const startedAt = new Date();
      const result = await callSkill(config, stageKey, input, signal);
      const entry = { ...scope, runId: record._id, stageKey, attempt: 1, status: "completed",
        startedAt, finishedAt: new Date(), verdict: result.verdict, output: result.report,
        openAIResponseId: result.responseId };
      await stages.insertOne(entry);
      stageExecutions.push(entry);
      return result;
    };
    try {
      const fields = version.excelFields ?? version.fields;
      const channel = Object.entries(fields ?? {}).find(([key]) => key.toLowerCase() === "channel")?.[1];
      const input = { client: brand.name, channel, knowledgeVersion: published?.version,
        brief: { fields, period: version.period, postCount: version.deliverables ?? version.postCount,
          objective: version.objective, audience: version.audience, kpi: version.kpi } };
      const context = await persistStage("context-assembler", { ...input, knowledge, stage: "Brief Qualifier" });
      qualificationResult.context = context;
      if (context.verdict !== "BLOCKED") {
        qualificationResult.qualification = await persistStage("brief-qualifier", {
          ...input, context: context.report, contextVerdict: context.verdict,
        });
        if (context.verdict === "LIMITED" && qualificationResult.qualification.verdict === "READY")
          qualificationResult.qualification.verdict = "LIMITED";
      }
    } catch (error) {
      console.error("Run qualification failed", error.code ?? error.name);
      qualificationResult.error = signal.aborted ? "Qualification timed out." : "A qualification stage failed.";
    }
    const verdict = qualificationResult.qualification?.verdict ?? qualificationResult.context?.verdict;
    const update = { qualificationResult, finishedAt: new Date() };
    const saved = await runs.findOneAndUpdate({ ...scope, _id: record._id, status: "running" }, {
      $set: { ...update, status: qualificationResult.error ? "failed" : verdict === "BLOCKED" ? "blocked" : "qualified" },
    }, { returnDocument: "after" });
    if (!saved) await runs.updateOne({ ...scope, _id: record._id }, { $set: { qualificationResult } });
    res.status(201).json({ record: saved ?? await runs.findOne({ ...scope, _id: record._id }), stageExecutions });
  });

  for (const [path, parentCollection] of [
    ["runs", "runs"], ["posts", "contentItems"],
  ]) {
    router.get(projectPath + "/" + path + "/:recordId", projectScope, async (req, res) => {
      const { scope } = res.locals.workflow;
      const id = objectId(req.params.recordId);
      if (!id) return res.status(400).json({ message: "Select a valid record." });
      const record = await db.collection(parentCollection).findOne({ ...scope, _id: id });
      if (!record) return res.sendStatus(404);
      if (path === "runs") {
        const [stageExecutions, reviewDecisions] = await Promise.all([
          db.collection("stageExecutions").find({ ...scope, runId: id }).sort({ _id: 1 }).toArray(),
          decisions.find({ ...scope, runId: id, gate: "gate_1" }).sort({ requestedAt: 1 }).toArray(),
        ]);
        return res.json({ record, stageExecutions, reviewDecisions });
      }
      const draftVersions = await db.collection("draftVersions").find({ ...scope, contentItemId: id })
        .sort({ _id: 1 }).toArray();
      const reviewDecisions = await db.collection("reviewDecisions").find({
        ...scope, draftVersionId: { $in: draftVersions.map((draft) => draft._id) },
      }).sort({ _id: 1 }).toArray();
      res.json({ record, draftVersions, reviewDecisions });
    });
  }
}
