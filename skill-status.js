// Which skills are configured on the server, for the Agents and skills page.
// Only a yes/no and the version number leave the server, never skill IDs or files.
const skillEnvKeys = {
  "social-content-orchestrator": "ORCHESTRATOR",
  "context-assembler": "CONTEXT", "brief-qualifier": "QUALIFIER", "content-planner": "PLANNER",
  "post-writer": "WRITER", "post-quality-analyst": "QA",
};

export function skillStatus(env = process.env) {
  return Object.fromEntries(Object.entries(skillEnvKeys).map(([stage, key]) => [stage, {
    configured: Boolean(env[`B2B_${key}_SKILL_ID`] && env[`B2B_${key}_SKILL_VERSION`]),
    version: env[`B2B_${key}_SKILL_VERSION`] || null,
  }]));
}

export function modelStatus(env = process.env) {
  return { apiKey: Boolean(env.OPENAI_API_KEY), model: env.OPENAI_MODEL || null };
}
