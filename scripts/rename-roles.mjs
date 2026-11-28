// One-time update: renames brand roles in the b2b_agents database.
//   knowledge_admin    -> brand_manager
//   marketing_operator -> operator
// Run once, before deploying the backend that uses the new names:
//   MONGODB_URI="mongodb+srv://..." node scripts/rename-roles.mjs
// Add --dry-run to only count the users that would change. Safe to run twice.
import { MongoClient } from "mongodb";

const renames = { knowledge_admin: "brand_manager", marketing_operator: "operator" };
const dryRun = process.argv.includes("--dry-run");
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? "b2b_agents";
if (!uri) {
  console.error("Set MONGODB_URI first.");
  process.exit(1);
}

const swap = (value) => {
  if (Array.isArray(value)) {
    const next = value.map(swap);
    return next.filter((item, index) => typeof item !== "string" || next.indexOf(item) === index);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item)]));
  }
  return typeof value === "string" && renames[value] ? renames[value] : value;
};

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const users = db.collection("users");
  const old = Object.keys(renames);
  const affected = await users.find({ "clientAssignments.roles": { $in: old } }).toArray();
  console.log(`${affected.length} user(s) have old role names.`);
  if (dryRun) process.exit(0);

  const [info] = await db.listCollections({ name: "users" }).toArray();
  const validator = info?.options?.validator;
  const level = info?.options?.validationLevel ?? "strict";
  const newValidator = validator ? swap(validator) : undefined;
  // Allow both names while the documents change, then keep only the new names.
  if (validator) {
    const both = JSON.parse(JSON.stringify(validator).replaceAll(
      /"enum":\[([^\]]*"knowledge_admin"[^\]]*)\]/g,
      (_, list) => `"enum":[${list},"brand_manager","operator"]`,
    ));
    await db.command({ collMod: "users", validator: both, validationLevel: level });
  }
  for (const user of affected) {
    const clientAssignments = user.clientAssignments.map((assignment) => ({
      ...assignment,
      roles: [...new Set(assignment.roles.map((role) => renames[role] ?? role))],
    }));
    await users.updateOne({ _id: user._id }, { $set: { clientAssignments } });
  }
  if (newValidator) await db.command({ collMod: "users", validator: newValidator, validationLevel: level });
  const left = await users.countDocuments({ "clientAssignments.roles": { $in: old } });
  console.log(`Done. ${affected.length} user(s) updated, ${left} left with old names. Users validator now uses the new names.`);
} finally {
  await client.close();
}
