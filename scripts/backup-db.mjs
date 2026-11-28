// Backs up every collection in the database to a folder of JSON files (no mongodump needed).
//   Backup:  MONGODB_URI="mongodb+srv://..." MONGODB_DB=b2b_agents node scripts/backup-db.mjs
//   Restore: MONGODB_URI="..." MONGODB_DB=b2b_agents node scripts/backup-db.mjs --restore <backup folder>
// Restore replaces each collection's documents with the ones in the backup. Indexes and validators stay as they are.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BSON, MongoClient } from "mongodb";

const { EJSON } = BSON;

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? "b2b_agents";
if (!uri) {
  console.error("Set MONGODB_URI first.");
  process.exit(1);
}
const restoreIndex = process.argv.indexOf("--restore");
const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  if (restoreIndex === -1) {
    const folder = `backup-${dbName}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    await mkdir(folder, { recursive: true });
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map(({ name }) => name).filter((name) => !name.startsWith("system."));
    for (const name of names) {
      const docs = await db.collection(name).find({}).toArray();
      await writeFile(join(folder, name + ".json"), EJSON.stringify(docs, { relaxed: false }));
      console.log(`${name}: ${docs.length} document(s)`);
    }
    console.log(`\nBackup saved in the folder ${folder} (${names.length} collections).`);
  } else {
    const folder = process.argv[restoreIndex + 1];
    if (!folder) throw new Error("Give the backup folder after --restore.");
    for (const file of (await readdir(folder)).filter((name) => name.endsWith(".json"))) {
      const name = file.slice(0, -5);
      const docs = EJSON.parse(await readFile(join(folder, file), "utf8"), { relaxed: false });
      await db.collection(name).deleteMany({});
      if (docs.length) await db.collection(name).insertMany(docs, { ordered: false, bypassDocumentValidation: true });
      console.log(`${name}: restored ${docs.length} document(s)`);
    }
  }
} finally {
  await client.close();
}
