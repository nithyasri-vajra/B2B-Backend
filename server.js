import { createHash, randomBytes } from "node:crypto";
import express from "express";
import { OAuth2Client } from "google-auth-library";
import { MongoClient, ObjectId } from "mongodb";

const { MONGODB_URI, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_ORIGIN, PLATFORM_ADMIN_EMAIL } = process.env;
const initOnly = process.argv.includes("--init-db");
if (!MONGODB_URI) throw new Error("Set MONGODB_URI in .env.");
if (!initOnly && ![GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_ORIGIN].every(Boolean))
  throw new Error("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and APP_ORIGIN in .env.");
let mongo;
try {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
} catch {
  throw new Error("Invalid MONGODB_URI in .env. Use the Atlas connection string and percent-encode special characters in the database password.");
}
try {
  await mongo.connect();
} catch (error) {
  const authFailed = error.code === 18 || error.code === 8000;
  throw new Error(authFailed
    ? "MongoDB authentication failed. Check the Atlas database username and password in .env."
    : "Could not connect to MongoDB. Check network connectivity and the Atlas IP access list.");
}
const db = mongo.db(process.env.MONGODB_DB || "social_content_dev");
const users = db.collection("users");
const sessions = db.collection("sessions");
const audits = db.collection("audit_events");
await users.createIndex({ googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: "string" } } });
await users.createIndex({ email: 1 }, { unique: true });
await sessions.createIndex({ tokenHash: 1 }, { unique: true });
await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
if (!(await db.listCollections({ name: "audit_events" }, { nameOnly: true }).hasNext())) {
  try {
    await db.createCollection("audit_events");
  } catch (error) {
    if (error.code !== 48) throw error;
  }
}
if (initOnly) {
  console.log(`MongoDB ready: ${db.databaseName}`);
  await mongo.close();
  process.exit(0);
}
const origin = new URL(APP_ORIGIN).origin;
const secure = origin.startsWith("https:");
const path = "/api/auth";
const google = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, origin + path + "/callback");

const app = express();
const auth = express.Router();
app.use(path, auth);
auth.use(express.json({ limit: "16kb" }));
auth.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.method === "POST" && req.get("origin") !== origin)
    return res.sendStatus(403);
  next();
});
const attempts = new Map();
const token = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cookieOptions = { httpOnly: true, sameSite: "lax", secure, path };
const cookie = (req, name) => req.headers.cookie?.split(";")
  .map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1);
const audit = (eventType, outcome, actorUserId = null, targetUserId = null, details = {}) =>
  audits.insertOne({ eventType, actorUserId, targetUserId, outcome, occurredAt: new Date(), details });
const eightHours = 8 * 60 * 60 * 1000;
const approvalIdleMs = 30 * 60 * 1000;
const stepUpMs = 5 * 60 * 1000;
const companyEmail = /^[^\s@]+@vajraglobal\.com$/;
const signInDenialMessages = new Map([
  ["work_account_required", "Sign in with your Vajra Global work account (@vajraglobal.com)."],
  ["sign_in_failed", "Google sign-in couldn't be completed. Please try again."],
]);
const roles = {
  knowledge_admin: "Knowledge Admin",
  approver: "Approver",
  marketing_operator: "Marketing Operator",
  viewer: "Viewer",
};

async function current(req) {
  const raw = cookie(req, "b2b_session");
  if (!raw) return {};
  const session = await sessions.findOne({ tokenHash: hash(raw) });
  if (!session || session.expiresAt <= new Date()) return {};
  const user = await users.findOne({ _id: session.userId });
  return { session, user };
}

auth.post("/sign-in", async (req, res) => {
  const now = Date.now();
  for (const [key, attempt] of attempts) {
    if (attempt.expires <= now) attempts.delete(key);
  }
  if (attempts.size >= 1000) return res.sendStatus(503);
  const state = token();
  const nonce = token();
  const verifier = token();
  const { user } = req.body?.reauthenticate === true ? await current(req) : {};
  if (req.body?.reauthenticate === true && user?.status !== "active") return res.sendStatus(403);
  attempts.set(state, { nonce, verifier, userId: user?._id, startedAt: now, expires: now + stepUpMs });
  res.cookie("b2b_oauth", state, { ...cookieOptions, maxAge: 300000 });
  res.clearCookie("b2b_denied", cookieOptions);
  const url = new URL(google.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    hd: "vajraglobal.com",
    prompt: user || req.body?.chooseAccount ? "select_account" : undefined,
  }));
  url.searchParams.set("nonce", nonce);
  if (user) {
    url.searchParams.set("max_age", "0");
    url.searchParams.set("claims", JSON.stringify({ id_token: { auth_time: { essential: true } } }));
  }
  res.json({ redirectUrl: url.href });
});

auth.get("/callback", async (req, res) => {
  const { state, code } = req.query;
  const attempt = typeof state === "string" && state === cookie(req, "b2b_oauth")
    ? attempts.get(state) : undefined;
  if (!attempt || attempt.expires <= Date.now()) {
    await audit("sign_in", "denied", null, null, { reason: "invalid_oauth_state" });
    return res.sendStatus(400);
  }
  attempts.delete(state);
  res.clearCookie("b2b_oauth", cookieOptions);
  const deny = async (reason = "1") => {
    await audit("sign_in", "denied");
    res.cookie("b2b_denied", reason, { ...cookieOptions, maxAge: 300000 });
    res.redirect(origin + "/#sign-in");
  };
  if (typeof code !== "string") return deny("sign_in_failed");

  let claims;
  try {
    const { tokens } = await google.getToken({ code, codeVerifier: attempt.verifier });
    const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
    claims = ticket.getPayload();
  } catch {
    return deny("sign_in_failed");
  }
  const email = claims?.email?.toLowerCase();
  if (claims?.nonce !== attempt.nonce || claims.email_verified !== true || !email || !claims.sub)
    return deny("sign_in_failed");
  if (claims.hd !== "vajraglobal.com" || !companyEmail.test(email))
    return deny("work_account_required");
  const now = new Date();
  let user = await users.findOne({ googleSub: claims.sub });
  if (attempt.userId) {
    const { session } = await current(req);
    if (!user?._id.equals(attempt.userId) || user.status !== "active" ||
        !session?.userId.equals(attempt.userId) || !Number.isInteger(claims.auth_time) ||
        claims.auth_time * 1000 < attempt.startedAt - 1000)
      return deny();
    await sessions.updateOne({ _id: session._id }, { $set: { lastReauthenticatedAt: now, lastActiveAt: now } });
    await audit("reauthentication", "success", user._id);
    return res.redirect(origin + "/?accessReauthenticated=1#requests");
  }
  if (!user) {
    const bootstrap = email === PLATFORM_ADMIN_EMAIL?.toLowerCase();
    // Only an explicitly pre-added record can be linked by verified company email.
    try {
      user = await users.findOneAndUpdate({ email, googleSub: null, status: { $in: ["active", "pending"] } }, {
        $set: { googleSub: claims.sub, name: claims.name || email, updatedAt: now },
      }, { returnDocument: "after" });
      user ??= await users.findOneAndUpdate({ googleSub: claims.sub }, {
        $setOnInsert: {
          googleSub: claims.sub, email, name: claims.name || email,
          status: bootstrap ? "active" : "pending",
          globalRoles: bootstrap ? ["platform_admin"] : [], clientAssignments: [],
          accessRequestedAt: now, accessRequestNote: null, accessRequestNoteAt: null,
          createdAt: now, updatedAt: now,
        },
      }, { upsert: true, returnDocument: "after" });
    } catch (error) {
      if (error.code !== 11000) throw error;
      user = await users.findOne({ googleSub: claims.sub });
      if (!user) return deny();
    }
  }
  const previous = await current(req);
  const raw = token();
  const signedIn = await mongo.withSession((tx) => tx.withTransaction(async () => {
    const options = { session: tx };
    const identity = await users.findOneAndUpdate({
      _id: user._id, status: { $in: ["active", "pending"] },
    }, {
      $set: { updatedAt: now },
    }, { ...options, returnDocument: "after" });
    if (!identity) return false;
    if (identity.status === "pending" && !identity.accessRequestedAt)
      await users.updateOne({ _id: user._id }, { $set: { accessRequestedAt: now } }, options);
    await sessions.insertOne({
      userId: user._id, tokenHash: hash(raw), createdAt: now, lastActiveAt: now,
      expiresAt: new Date(now.getTime() + eightHours), lastReauthenticatedAt: null,
    }, options);
    if (previous.session) await sessions.deleteOne({ _id: previous.session._id }, options);
    await audits.insertOne({
      eventType: "sign_in", actorUserId: user._id, targetUserId: null,
      outcome: identity.status, occurredAt: now, details: {},
    }, options);
    return true;
  }));
  if (!signedIn) return deny();
  res.clearCookie("b2b_denied", cookieOptions);
  res.cookie("b2b_session", raw, { ...cookieOptions, maxAge: eightHours });
  res.redirect(origin + "/#sign-in");
});

auth.get("/session", async (req, res) => {
  const reply = (session) => res.json({ data: { session } });
  const denial = cookie(req, "b2b_denied");
  if (denial) return reply({ status: "denied", reason: signInDenialMessages.get(denial) });
  const { session, user } = await current(req);
  if (!session) return reply(cookie(req, "b2b_session") ? { status: "expired" } : null);
  if (!user || !["active", "pending"].includes(user.status)) return reply({ status: "denied" });
  const isAdmin = user.globalRoles?.includes("platform_admin");
  const assignments = user.clientAssignments ?? [];
  const assignedRoles = assignments.flatMap(({ roles }) => roles);
  const role = isAdmin ? "Platform Admin" : Object.keys(roles)
    .filter((key) => assignedRoles.includes(key)).map((key) => roles[key])[0];
  return reply({
    status: role ? user.status : "pending", email: user.email, name: user.name,
    role, clientIds: assignments.map(({ clientId }) => String(clientId)),
    globalRoles: user.globalRoles ?? [], clientAssignments: assignments,
  });
});

// Approval routes can call this guard before touching session activity.
auth.post("/approval-session", async (req, res) => {
  const { user, session } = await current(req);
  if (!session) return res.sendStatus(401);
  if (user?.status !== "active" || typeof req.body?.clientId !== "string" ||
      !user.clientAssignments?.some(({ clientId, roles }) =>
        String(clientId) === req.body.clientId && roles.includes("approver")))
    return res.sendStatus(403);
  const now = new Date();
  if (now - session.lastActiveAt >= approvalIdleMs ||
      (req.body.gate === 2 && !recentStepUp(session)))
    return res.status(403).json({ code: "reauthentication_required" });
  await sessions.updateOne({ _id: session._id }, { $max: { lastActiveAt: now } });
  res.sendStatus(204);
});

auth.post("/request-access", async (req, res) => {
  const { user } = await current(req);
  if (user?.status !== "pending") return res.sendStatus(403);
  const note = req.body?.note;
  if (typeof note !== "string" || !note.trim() || note.length > 2000) return res.sendStatus(400);
  const now = new Date();
  const result = await users.updateOne({ _id: user._id, status: "pending" }, {
    $set: { accessRequestNote: note.trim(), accessRequestNoteAt: now, updatedAt: now },
  });
  if (!result.matchedCount) return res.sendStatus(409);
  res.json({ message: "Your note was sent to the Platform Admin." });
});

auth.post("/sign-out", async (req, res) => {
  const raw = cookie(req, "b2b_session");
  if (raw) await sessions.deleteOne({ tokenHash: hash(raw) });
  res.clearCookie("b2b_session", cookieOptions);
  res.clearCookie("b2b_denied", cookieOptions);
  res.sendStatus(204);
});

const isPlatformAdmin = (user) =>
  user?.status === "active" && user.globalRoles?.includes("platform_admin");
const recentStepUp = (session) =>
  session.lastReauthenticatedAt instanceof Date && Date.now() - session.lastReauthenticatedAt <= stepUpMs;
const accessSnapshot = ({ status, globalRoles = [], clientAssignments = [] }) =>
  ({ status, globalRoles, clientAssignments });

auth.get("/clients", async (req, res) => {
  const { user } = await current(req);
  if (user?.status !== "active") return res.sendStatus(403);
  const filter = isPlatformAdmin(user) ? {} : {
    _id: { $in: (user.clientAssignments ?? []).flatMap(({ clientId }) => {
      const id = String(clientId);
      return ObjectId.isValid(id) ? [id, new ObjectId(id)] : [id];
    }) },
  };
  const clients = await db.collection("clients").find(filter, {
    projection: { name: 1, channel: 1, archived: 1, website: 1, industry: 1, timezone: 1, language: 1 },
  }).toArray();
  res.json({ data: { clients: clients.map(({ _id, ...client }) => ({ id: String(_id), ...client })) } });
});

auth.post("/clients", async (req, res) => {
  const { user } = await current(req);
  if (!isPlatformAdmin(user)) return res.sendStatus(403);
  const profile = Object.fromEntries(["name", "website", "industry", "timezone", "language"]
    .map((field) => [field, typeof req.body?.[field] === "string" ? req.body[field].trim() : ""]));
  if (!profile.name || Object.values(profile).some((value) => value.length > 2000))
    return res.status(400).json({ message: "Enter a valid client profile." });
  const clients = db.collection("clients");
  const existing = await clients.findOne({ name: profile.name, archived: { $ne: true } },
    { collation: { locale: "en", strength: 2 } });
  if (existing) return res.status(409).json({ message: "A client with this name already exists." });
  const { insertedId } = await clients.insertOne(profile);
  res.status(201).json({ data: { clients: [{ id: String(insertedId), ...profile }] } });
});

auth.get("/users", async (req, res) => {
  const { user } = await current(req);
  if (!isPlatformAdmin(user)) return res.sendStatus(403);
  const statuses = ["active", "pending", "suspended", "deactivated"];
  if (req.query.status !== undefined && !statuses.includes(req.query.status)) return res.sendStatus(400);
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647)
    return res.sendStatus(400);
  const filter = req.query.status ? { status: req.query.status } : {};
  const pageSize = 250;
  const records = await users.find(filter, { projection: { googleSub: 0 } })
    .sort({ _id: 1 }).skip(offset).limit(pageSize + 1).toArray();
  res.json({ data: {
    users: records.slice(0, pageSize),
    nextOffset: records.length > pageSize ? offset + pageSize : null,
  } });
});

auth.post("/user-access", async (req, res) => {
  const { user, session } = await current(req);
  if (!isPlatformAdmin(user)) return res.sendStatus(403);
  const { clientAssignments = [], globalRoles = [], reason = "", confirmPlatformAdmin } = req.body ?? {};
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const action = req.body?.action ?? "assign";
  const assigning = ["assign", "pre_add"].includes(action);
  if (!companyEmail.test(email) || typeof reason !== "string" || reason.length > 2000 ||
      !["assign", "pre_add", "suspend", "decline"].includes(action) ||
      !Array.isArray(globalRoles) || globalRoles.length > 1 ||
      !globalRoles.every((role) => role === "platform_admin") ||
      !Array.isArray(clientAssignments) ||
      !clientAssignments.every((assignment) => typeof assignment?.clientId === "string" &&
        assignment.clientId.trim() && Array.isArray(assignment.roles) && assignment.roles.length &&
        assignment.roles.every((role) => Object.hasOwn(roles, role))) ||
      new Set(clientAssignments.map(({ clientId }) => clientId)).size !== clientAssignments.length)
    return res.sendStatus(400);
  const assignments = clientAssignments.map(({ clientId, roles }) => ({ clientId, roles: [...new Set(roles)] }));
  const active = assigning && (globalRoles.length > 0 || assignments.length > 0);
  const status = assigning ? (active ? "active" : "pending") : "suspended";
  const after = { status, globalRoles: assigning ? globalRoles : [], clientAssignments: assigning ? assignments : [] };

  const result = await mongo.withSession((tx) => tx.withTransaction(async () => {
    const options = { session: tx };
    // Serialize access changes with changes to the acting admin's own user record.
    const actor = await users.updateOne({
      _id: user._id, status: "active", globalRoles: "platform_admin",
    }, { $set: { updatedAt: new Date() } }, options);
    const activeSession = await sessions.findOne({ _id: session._id, expiresAt: { $gt: new Date() } }, options);
    if (!actor.matchedCount || !activeSession) return 403;
    const target = await users.findOne({ email }, options);
    if (action === "pre_add" && target) return 409;
    if (action !== "pre_add" && !target) return 404;
    if (action === "decline" && target.status !== "pending") return 409;
    if (assigning && target?.status === "deactivated") return 409;
    if (target?._id.equals(user._id)) return 403;
    const wasPlatformAdmin = target?.globalRoles?.includes("platform_admin") === true;
    const willBePlatformAdmin = after.globalRoles.includes("platform_admin");
    if ((action !== "assign" || wasPlatformAdmin || willBePlatformAdmin) && !recentStepUp(activeSession))
      return "reauthentication_required";
    if (wasPlatformAdmin !== willBePlatformAdmin && (confirmPlatformAdmin !== true || !reason.trim()))
      return 400;
    if (assigning && assignments.length) {
      const ids = assignments.flatMap(({ clientId }) =>
        ObjectId.isValid(clientId) ? [clientId, new ObjectId(clientId)] : [clientId]);
      const clients = await db.collection("clients").find({ _id: { $in: ids } }, {
        ...options, projection: { _id: 1 },
      }).toArray();
      const found = new Set(clients.map(({ _id }) => String(_id)));
      if (!assignments.every(({ clientId }) => found.has(clientId))) return "invalid_client_assignment";
    }
    const now = new Date();
    const targetUserId = target?._id ?? new ObjectId();
    let savedUser;
    if (target) {
      savedUser = await users.findOneAndUpdate(
        { _id: targetUserId }, { $set: { ...after, updatedAt: now } },
        { ...options, returnDocument: "after", projection: { googleSub: 0 } },
      );
      if (!savedUser) return 404;
      await sessions.deleteMany({ userId: targetUserId }, options);
    } else {
      savedUser = {
        _id: targetUserId, googleSub: null, email, name: email, ...after,
        accessRequestedAt: null, accessRequestNote: null, accessRequestNoteAt: null, createdAt: now, updatedAt: now,
      };
      await users.insertOne(savedUser, options);
    }
    await audits.insertOne({
      eventType: "user_access_changed", outcome: "success", actorUserId: user._id, targetUserId, occurredAt: now,
      details: { action, reason: reason.trim(), before: target ? accessSnapshot(target) : null, after },
    }, options);
    const { googleSub, ...record } = savedUser;
    return record;
  }));
  if (result === "reauthentication_required")
    return res.status(403).json({ code: result });
  if (result === "invalid_client_assignment")
    return res.status(400).json({ code: result, message: "A selected client no longer exists. Refresh the page and select an available client." });
  if (typeof result === "number") return res.sendStatus(result);
  res.json({ message: "Access updated.", data: { users: [result] } });
});

app.use((error, req, res, next) => {
  console.error("Auth request failed", error.code ?? error.name);
  if (req.method === "POST" && req.originalUrl === path + "/user-access" && error.code === 121)
    return res.status(422).json({ message: "MongoDB rejected the access change because it does not match the database schema." });
  const status = error.code === 11000 ? 409 : error.status === 400 || error.status === 413 ? error.status : 500;
  res.status(status).json({ message: "Could not complete the authentication request." });
});
app.listen(Number(process.env.PORT ?? 3001), process.env.BIND_HOST ?? "127.0.0.1", () => console.log("B2B auth API ready."));
