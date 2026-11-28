// Uploads the six skills the backend calls to OpenAI (orchestrator + context assembler + 4 stage skills)
// and prints the 12 Render settings. Point it at the skills folder of the optimised B2B repo
// (branch optimize-context-assembler), which contains social-content-orchestrator/.
// Needs Node 20+. Nothing is deleted by default.
//
//   Upload: OPENAI_API_KEY=sk-... node upload-skills.mjs "<path to the skills folder>"
//   List:   OPENAI_API_KEY=sk-... node upload-skills.mjs --list
//   Delete: OPENAI_API_KEY=sk-... node upload-skills.mjs --delete skill_abc123
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const API = "https://api.openai.com/v1/skills";
const key = process.env.OPENAI_API_KEY;
if (!key) { console.error("Set OPENAI_API_KEY first."); process.exit(1); }
const auth = { Authorization: `Bearer ${key}` };

// Same order and names as workflow-routes.js skillSettings.
const SKILLS = [
  ["social-content-orchestrator", "ORCHESTRATOR"], ["context-assembler", "CONTEXT"],
  ["brief-qualifier", "QUALIFIER"], ["content-planner", "PLANNER"],
  ["post-writer", "WRITER"], ["post-quality-analyst", "QA"],
];

async function call(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...auth, ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.error?.message || JSON.stringify(body)}`);
  return body;
}

async function list() {
  let after = null; const all = [];
  do {
    const page = await call(`${API}?limit=100${after ? `&after=${after}` : ""}`);
    all.push(...page.data); after = page.has_more ? page.last_id : null;
  } while (after);
  if (!all.length) return console.log("No skills on this API key's project.");
  for (const s of all)
    console.log(`${s.id}  ${s.name}  latest=${s.latest_version} default=${s.default_version}  created ${new Date(s.created_at * 1000).toISOString().slice(0, 16)}`);
}

async function upload(folder) {
  const lines = [];
  for (const [name, env] of SKILLS) {
    const dir = join(folder, name);
    const file = (await readdir(dir)).find((f) => f.toLowerCase() === "skill.md");
    if (!file) throw new Error(`No SKILL.md in ${dir}`);
    const form = new FormData();
    // Sent as <name>/SKILL.md, so a lowercase skill.md on disk is fine.
    form.append("files[]", new Blob([await readFile(join(dir, file))], { type: "text/markdown" }), `${name}/SKILL.md`);
    const skill = await call(API, { method: "POST", body: form });
    console.log(`uploaded ${name}: ${skill.id} (version ${skill.latest_version})`);
    lines.push(`B2B_${env}_SKILL_ID=${skill.id}`, `B2B_${env}_SKILL_VERSION=${skill.latest_version}`);
  }
  console.log("\nAdd these 12 settings on Render (backend service > Environment):\n\n" + lines.join("\n"));
}

const [arg, value] = process.argv.slice(2);
try {
  if (arg === "--list") await list();
  else if (arg === "--delete") {
    if (!value) throw new Error("Give the skill id to delete.");
    console.log(await call(`${API}/${value}`, { method: "DELETE" }));
  } else if (arg) await upload(arg);
  else console.log('Usage: node upload-skills.mjs "<skills folder>" | --list | --delete <skill_id>');
} catch (e) { console.error("Failed:", e.message); process.exit(1); }
