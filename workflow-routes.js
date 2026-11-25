import { ObjectId } from "mongodb";
import { parseId, cleanText } from "./brand-routes.js";

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

  router.post(projectPath + "/briefs", projectScope, async (req, res) => {
    const { scope, user, project } = res.locals.workflow;
    if (!hasClientRole(user, String(scope.clientId), ["marketing_operator", "approver"]))
      return res.sendStatus(403);
    if (project.status !== "active" || res.locals.workflow.brand?.status === "archived")
      return res.status(409).json({ message: "This project is inactive." });
    const { title, briefId, currentVersion, period, objective, audience, deliverables, kpi,
      agentId: agentKey, fileRef, templateVersion, keyDates, blackoutDays, postingSlots } = req.body ?? {};
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
