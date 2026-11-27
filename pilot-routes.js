import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { assessReadiness, mergeReadiness, resolvePublishedKnowledge } from "./brand-routes.js";
import { executeSkill } from "./workflow-routes.js";

const receivingStages = new Set([
  "brief-qualifier", "content-planner", "post-writer", "post-quality-analyst",
  "competitor-scan", "publish-and-verify",
]);
const validId = (id) => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id);
const maxAttempts = 3;
const claimDuration = 11 * 60_000;
const stageKey = "context-assembler";
const runRoles = ["marketing_operator", "approver"];

export function registerPilotRoutes(router, { db, mongo, current, hasClientRole }) {
  const jobs = db.collection("contextJobs");
  const runs = db.collection("runs");
  const stages = db.collection("stageExecutions");
  const transaction = (work) => mongo.withSession((session) => session.withTransaction(() => work(session)));
  const jobScope = ({ clientId, projectId }) => ({ clientId, projectId });
  const statusPath = (id) => "/run-context/" + id;
  const jobStatus = (job) => ({
    job_id: String(job._id), run_id: String(job._id), status: job.status, attempt: job.attempt,
    ...(job.failure ? { failure: job.failure } : {}),
    ...(job.result ?? {}),
  });

  async function claimJob() {
    return transaction(async (session) => {
      const now = new Date();
      const claimId = new ObjectId();
      const previous = await jobs.findOneAndUpdate({ availableAt: { $lte: now } }, {
        $set: { status: "running", claimId, availableAt: new Date(+now + claimDuration) },
      }, { session, sort: { availableAt: 1 }, returnDocument: "before" });
      if (!previous) return null;
      const scope = jobScope(previous);
      const key = { ...scope, _id: previous._id };
      const run = await runs.findOne(key, { session });
      const interrupted = "The previous attempt stopped before recording a result.";
      if (previous.status === "running") await stages.updateOne({
        ...scope, runId: previous._id, stageKey, attempt: previous.attempt, status: "running",
      }, { $set: { status: "failed", failure: interrupted, finishedAt: now } }, { session });
      if (!run || run.status === "cancelled" || previous.attemptsInCycle >= maxAttempts) {
        const status = !run || run.status === "cancelled" ? "cancelled" : "failed";
        await jobs.updateOne(key, { $set: { status, ...(status === "failed" ? { failure: interrupted } : {}) },
          $unset: { availableAt: "", claimId: "" } }, { session });
        if (status === "failed") await runs.updateOne(key, {
          $set: { status, finishedAt: now, blocker: { reason: interrupted } },
        }, { session });
        return { skipped: true };
      }
      const attempt = previous.attempt + 1;
      const attemptsInCycle = previous.attemptsInCycle + 1;
      await jobs.updateOne(key, { $set: { attempt, attemptsInCycle } }, { session });
      await runs.updateOne(key, { $set: { status: "running", startedAt: run.startedAt ?? now } }, { session });
      await stages.insertOne({ ...scope, runId: previous._id, stageKey, attempt,
        receivingStage: previous.receivingStage, selectedItem: previous.selectedItem,
        status: "running", startedAt: now,
      }, { session });
      return { ...previous, claimId, attempt, attemptsInCycle };
    });
  }

  async function finishJob(job, result, failure, transient = false) {
    const now = new Date();
    const scope = jobScope(job);
    const key = { ...scope, _id: job._id };
    await transaction(async (session) => {
      const run = await runs.findOne(key, { session });
      const cancelled = !run || run.status === "cancelled";
      const retry = !cancelled && failure && transient && job.attemptsInCycle < maxAttempts;
      const status = cancelled ? "cancelled" : retry ? "queued" : failure ? "failed" :
        result.readiness.blocked ? "blocked" : "completed";
      const jobUpdate = { $set: { status }, $unset: { claimId: "" } };
      if (failure) jobUpdate.$set.failure = failure;
      else jobUpdate.$unset.failure = "";
      if (retry) jobUpdate.$set.availableAt = new Date(+now + 1000 * 2 ** (job.attemptsInCycle - 1));
      else jobUpdate.$unset.availableAt = "";
      if (result && !cancelled) jobUpdate.$set.result = result;
      const saved = await jobs.updateOne({ ...key, status: "running", claimId: job.claimId }, jobUpdate, { session });
      if (!saved.matchedCount) return;
      if (!cancelled) await runs.updateOne(key, { $set: { status,
        ...(!retry ? { finishedAt: now } : {}),
        ...(failure ? { blocker: { reason: failure } } : {
          readiness: result.readiness, openAIResponseId: result.response_id,
        }),
      }, ...(!failure ? { $unset: { blocker: "" } } : {}) }, { session });
      await stages.updateOne({ ...scope, runId: job._id, stageKey, attempt: job.attempt, status: "running" },
        { $set: { status: cancelled ? "cancelled" : failure ? "failed" : status, finishedAt: now,
          ...(failure ? { failure } : !cancelled ? { output: result.output } : {}),
        } }, { session });
    });
  }

  async function executeJob(job) {
    const scope = jobScope(job);
    const [brand, brief, agent, project, owner] = await Promise.all([
      db.collection("brands").findOne({ _id: new ObjectId(scope.clientId), status: "active" }),
      db.collection("briefs").findOne({ ...scope, _id: job.briefId }),
      db.collection("agents").findOne({ _id: job.agentId, agentKey: job.agentKey, releaseStatus: "live" }),
      db.collection("projects").findOne({ _id: scope.projectId, clientId: scope.clientId, status: "active" }),
      db.collection("users").findOne({ _id: job.ownerUserId, status: "active" }),
    ]);
    if (!brand || !agent || !project || !owner || !hasClientRole(owner, String(scope.clientId), runRoles) ||
        !brand.agents?.some((entry) => entry.enabled === true && entry.agentKey === job.agentKey))
      return finishJob(job, null, "The run scope or permissions are no longer available.");
    const revision = brief?.versions?.find(({ version }) => version === job.briefVersion);
    const snapshot = await resolvePublishedKnowledge(db, brand, { versionId: job.knowledgeVersionId });
    const { knowledge, readiness } = assessReadiness(snapshot, {
      agentKey: job.agentKey, brief: revision, requireBrief: true,
    });
    if (readiness.blocked) return finishJob(job, { output: readiness.reason, verdict: readiness.verdict, readiness });
    let result;
    try {
      result = await executeSkill(stageKey, {
        receivingStage: job.receivingStage, selectedItem: job.selectedItem, client: brand.name,
        channel: revision.channel, agent: job.agentKey, brief: { title: job.briefTitle, ...revision },
        knowledgeVersion: snapshot.version.version, knowledge, readiness,
      });
    } catch (error) {
      const transient = ["TimeoutError", "TypeError", "AbortError"].includes(error.name) ||
        /\(HTTP (408|429|500|502|503|504)\)/.test(error.message);
      const failure = transient ? "The Context Assembler request timed out or was temporarily unavailable."
        : "The Context Assembler could not complete this attempt.";
      return finishJob(job, null, failure, transient);
    }
    const effective = mergeReadiness(readiness, result.verdict, result.report);
    return finishJob(job, { response_id: result.responseId, output: result.report, verdict: effective.verdict, readiness: effective });
  }

  let draining = false;
  async function drainJobs() {
    if (draining) return;
    draining = true;
    try {
      while (true) {
        const job = await claimJob();
        if (!job) return;
        if (!job.skipped) await executeJob(job);
      }
    } catch (error) {
      console.error("Could not process context jobs", error.code ?? error.name);
    } finally {
      draining = false;
    }
  }
  setInterval(drainJobs, 5000).unref();

  async function readJob(req, res) {
    const { user } = await current(req);
    if (!user) { res.sendStatus(401); return null; }
    if (user.status !== "active") { res.sendStatus(403); return null; }
    if (!validId(req.params.jobId)) { res.sendStatus(400); return null; }
    const job = await jobs.findOne({ _id: new ObjectId(req.params.jobId), ownerUserId: user._id });
    if (!job || !hasClientRole(user, String(job.clientId), runRoles)) { res.sendStatus(404); return null; }
    return job;
  }

  router.get("/run-context/:jobId", async (req, res) => {
    const job = await readJob(req, res);
    if (!job) return;
    const run = await runs.findOne({ ...jobScope(job), _id: job._id }, { projection: { status: 1 } });
    res.json(jobStatus(run?.status === "cancelled" ? { ...job, status: "cancelled" } : job));
  });

  router.post("/run-context/:jobId/retry", async (req, res) => {
    const job = await readJob(req, res);
    if (!job) return;
    const resumed = await transaction(async (session) => {
      const key = { ...jobScope(job), _id: job._id };
      const run = await runs.findOne(key, { session });
      if (!run || run.status === "cancelled") return null;
      const latest = await jobs.findOne(key, { session });
      if (latest?.status !== "failed") return latest;
      const queued = await jobs.findOneAndUpdate({ ...key, status: "failed" }, {
        $set: { status: "queued", attemptsInCycle: 0, availableAt: new Date() },
        $unset: { failure: "" },
      }, { session, returnDocument: "after" });
      if (queued) await runs.updateOne(key, {
        $set: { status: "queued" }, $unset: { finishedAt: "", blocker: "" },
      }, { session });
      return queued;
    });
    if (!resumed) return res.sendStatus(409);
    res.status(resumed.status === "queued" || resumed.status === "running" ? 202 : 200).json(jobStatus(resumed));
    void drainJobs();
  });
  router.post("/run-context", async (req, res) => {
    const { user } = await current(req);
    if (!user) return res.sendStatus(401);
    if (user.status !== "active") return res.sendStatus(403);
    const {
      receiving_stage: receivingStage, brief_id: briefId, knowledge_version_ids: knowledgeIds,
      selected_item: selectedItem = null, project_id: projectId, brief_version: revisionNumber,
      agent_key: requestedAgent, run_id: parentRunId,
    } = req.body ?? {};
    if (!receivingStages.has(receivingStage) || !validId(projectId) ||
        (parentRunId === undefined ? !validId(briefId) || requestedAgent === undefined : !validId(parentRunId)) ||
        (briefId !== undefined && !validId(briefId)) ||
        (revisionNumber !== undefined && (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1)) ||
        (requestedAgent !== undefined && (typeof requestedAgent !== "string" || !requestedAgent.trim())) ||
        (knowledgeIds !== undefined && (!Array.isArray(knowledgeIds) || !knowledgeIds.length || !knowledgeIds.every(validId))) ||
        (selectedItem !== null && (typeof selectedItem !== "string" || selectedItem.length > 200)))
      return res.status(400).json({ detail: "Select a project and stage, and supply its run or its saved brief and agent." });

    try {
      const project = await db.collection("projects").findOne({
        _id: new ObjectId(projectId), status: "active",
      });
      if (!project || !hasClientRole(user, String(project.clientId), ["marketing_operator", "approver"]))
        return res.sendStatus(403);
      const scope = { clientId: project.clientId, projectId: project._id };
      const brand = ObjectId.isValid(project.clientId) && await db.collection("brands").findOne({
        _id: new ObjectId(project.clientId), status: "active",
      });
      if (!brand) return res.status(422).json({ detail: "The project's active brand is unavailable." });
      const parentRun = parentRunId && await db.collection("runs").findOne({ ...scope, _id: new ObjectId(parentRunId) });
      if (parentRunId && !parentRun) return res.sendStatus(404);
      if (parentRun && (!parentRun.briefId || !parentRun.briefVersion || !parentRun.knowledgeVersionId ||
          (!parentRun.agentId && !parentRun.agentKey) ||
          (briefId && !new ObjectId(briefId).equals(parentRun.briefId)) ||
          (revisionNumber !== undefined && revisionNumber !== parentRun.briefVersion) ||
          (selectedItem !== null && !parentRun.planRevisions?.at(-1)?.items?.some(
            ({ itemId }) => String(itemId) === selectedItem,
          ))))
        return res.status(422).json({ detail: "The brief, knowledge, agent and selected item must match the scoped run." });
      const brief = await db.collection("briefs").findOne({ ...scope,
        _id: new ObjectId(parentRun?.briefId ?? briefId),
      });
      if (!brief) return res.sendStatus(404);
      const briefVersion = brief.versions?.find(({ version }) =>
        version === (parentRun?.briefVersion ?? revisionNumber ?? brief.currentVersion));
      const agent = await db.collection("agents").findOne({
        releaseStatus: "live",
        ...(parentRun?.agentId ? { _id: new ObjectId(parentRun.agentId) } :
          { agentKey: parentRun?.agentKey ?? requestedAgent }),
      });
      if (!agent || !brand.agents?.some((entry) => entry.enabled === true && entry.agentKey === agent.agentKey) ||
          (requestedAgent !== undefined && requestedAgent !== agent.agentKey) ||
          (parentRun?.agentKey && parentRun.agentKey !== agent.agentKey) ||
          (brief.agentId && !agent._id.equals(brief.agentId)))
        return res.status(422).json({ detail: "Select an enabled live agent that matches the scoped brief and run." });
      const snapshot = await resolvePublishedKnowledge(db, brand, { versionId: parentRun?.knowledgeVersionId });
      if (knowledgeIds?.some((id) => id.toLowerCase() !== String(snapshot.version?._id)))
        return res.status(422).json({ detail: "Use the published knowledge version for this brand and run." });
      const { readiness } = assessReadiness(snapshot, {
        agentKey: agent.agentKey, brief: briefVersion, requireBrief: true,
      });
      if (readiness.blocked) return res.status(422).json({ detail: readiness.reason, readiness });
      const hash = createHash("sha256").update(JSON.stringify([
        scope.clientId, scope.projectId, user._id, parentRun?._id ?? null, brief._id,
        briefVersion.version, agent._id, snapshot.version._id, receivingStage, selectedItem,
      ])).digest("hex");
      const _id = new ObjectId(hash.slice(0, 24));
      const key = { ...scope, _id, ownerUserId: user._id };
      const existing = await jobs.findOne(key);
      if (existing) return res.status(existing.status === "queued" || existing.status === "running" ? 202 : 200).json(jobStatus(existing));
      const { OPENAI_API_KEY, OPENAI_MODEL, B2B_CONTEXT_SKILL_ID, B2B_CONTEXT_SKILL_VERSION } = process.env;
      if (!OPENAI_API_KEY || !OPENAI_MODEL || !B2B_CONTEXT_SKILL_ID || !B2B_CONTEXT_SKILL_VERSION)
        return res.status(503).json({ detail: "Configure the Context Assembler skill on the backend." });

      const now = new Date();
      const run = { ...key, kind: "context-assembly", status: "queued", currentStageKey: stageKey,
        briefId: brief._id, briefVersion: briefVersion.version, agentId: agent._id, agentKey: agent.agentKey,
        readiness, knowledgeVersionId: snapshot.version._id, createdAt: now,
      };
      const job = { ...run, briefTitle: brief.title, receivingStage, selectedItem, availableAt: now,
        attempt: 0, attemptsInCycle: 0 };
      try {
        await transaction(async (session) => {
          await jobs.insertOne(job, { session });
          await runs.insertOne(run, { session });
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
        const submitted = await jobs.findOne(key);
        if (!submitted) throw error;
        return res.status(submitted.status === "queued" || submitted.status === "running" ? 202 : 200).json(jobStatus(submitted));
      }
      res.location(req.baseUrl + statusPath(_id)).status(202).json(jobStatus(job));
      void drainJobs();
    } catch (error) {
      console.error("Pilot context request failed", error.code ?? error.name);
      const status = error.name === "TimeoutError" ? 504 : 502;
      res.status(status).json({ detail: "Could not confirm the skill run. Check the service before retrying." });
    }
  });
}
