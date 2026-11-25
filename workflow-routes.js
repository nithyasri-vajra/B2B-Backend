import { ObjectId } from "mongodb";

const clientRoles = ["knowledge_admin", "marketing_operator", "approver", "viewer"];
const objectId = (value) => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value)
  ? new ObjectId(value) : null;
const cleanText = (value) => typeof value === "string" ? value.trim() : "";

export function registerWorkflowRoutes(router, { db, current, isPlatformAdmin, hasClientRole }) {
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
    res.locals.workflow = { scope: { clientId: project.clientId, projectId }, user, project };
    next();
  };

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
    if (!hasClientRole(user, String(scope.clientId), ["marketing_operator"]))
      return res.sendStatus(403);
    if (project.status !== "active") return res.status(409).json({ message: "This project is inactive." });
    const { title, briefId, currentVersion, period, objective, audience, deliverables, kpi } = req.body ?? {};
    if (!cleanText(title) || !cleanText(period) || !cleanText(objective) || !cleanText(audience) ||
        deliverables == null || kpi == null)
      return res.status(400).json({ message: "Complete the brief title, period, objective, audience, deliverables and KPI." });
    const version = { period, objective, audience, deliverables, kpi, savedBy: user._id, savedAt: new Date() };
    const briefs = db.collection("briefs");
    if (briefId === undefined) {
      const brief = { ...scope, title: title.trim(), currentVersion: 1, versions: [{ version: 1, ...version }] };
      const { insertedId } = await briefs.insertOne(brief);
      return res.status(201).json({ brief: { ...brief, _id: insertedId } });
    }
    const id = objectId(briefId);
    if (!id || !Number.isSafeInteger(currentVersion) || currentVersion < 1)
      return res.status(400).json({ message: "Select the brief and its current revision." });
    const brief = await briefs.findOneAndUpdate({ ...scope, _id: id, currentVersion }, {
      $set: { title: title.trim() }, $inc: { currentVersion: 1 },
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
        const stageExecutions = await db.collection("stageExecutions").find({ ...scope, runId: id })
          .sort({ _id: 1 }).toArray();
        return res.json({ record, stageExecutions });
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
