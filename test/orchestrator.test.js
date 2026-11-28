// Offline checks for the optimised orchestrator flow. No OpenAI key or database needed.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleWorkflowContext, executeSkill, packageBlocker, workflowStages } from "../workflow-routes.js";

for (const key of ["ORCHESTRATOR", "CONTEXT", "QUALIFIER", "PLANNER", "WRITER", "QA"]) {
  process.env[`B2B_${key}_SKILL_ID`] = `skill_${key.toLowerCase()}`;
  process.env[`B2B_${key}_SKILL_VERSION`] = "1";
}
process.env.OPENAI_API_KEY = "test";
process.env.OPENAI_MODEL = "test-model";

function mockOpenAI(value, { status = "completed" } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      id: "resp_1", status, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
      output: [
        { type: "shell_call" },
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify(value) }] },
      ],
    }), { status: 200 });
  };
  return calls;
}

const pkg = (verdict, pendingDependenciesOnly = false) => ({ verdict, pendingDependenciesOnly, report: `# Run Context Package (${verdict})` });

test("one call attaches the orchestrator and context assembler and returns four packages", async () => {
  const calls = mockOpenAI({
    "brief-qualifier": pkg("READY"), "content-planner": pkg("BLOCKED", true),
    "post-writer": pkg("BLOCKED", true), "post-quality-analyst": pkg("BLOCKED", true),
  });
  const { packages, responseId } = await assembleWorkflowContext({ client: "Vajra Global", runId: "r1" });
  assert.equal(calls.length, 1);
  const skills = calls[0].body.tools[0].environment.skills.map(({ skill_id }) => skill_id);
  assert.deepEqual(skills, ["skill_orchestrator", "skill_context"]);
  assert.deepEqual(calls[0].body.text.format.schema.required, workflowStages);
  assert.equal(responseId, "resp_1");
  assert.equal(packages["post-writer"].pendingDependenciesOnly, true);
  // Waiting only for earlier outputs is not a blocker.
  assert.equal(packageBlocker(packages), null);
});

test("a real blocker in any package blocks the run", () => {
  const blocker = packageBlocker({
    "brief-qualifier": pkg("READY"), "content-planner": pkg("BLOCKED", false),
    "post-writer": pkg("BLOCKED", true), "post-quality-analyst": pkg("BLOCKED", true),
  });
  assert.match(blocker, /^Content Planner context is blocked/);
});

test("assembly can be limited to the stages that are missing", async () => {
  const calls = mockOpenAI({ "post-writer": pkg("READY"), "post-quality-analyst": pkg("READY") });
  await assembleWorkflowContext({ runId: "r1" }, ["post-writer", "post-quality-analyst"]);
  assert.deepEqual(calls[0].body.text.format.schema.required, ["post-writer", "post-quality-analyst"]);
});

test("a missing package in the result is rejected", async () => {
  mockOpenAI({ "brief-qualifier": pkg("READY") });
  await assert.rejects(assembleWorkflowContext({ runId: "r1" }), /invalid result/);
});

test("a skill given a context package attaches only its own skill and is told not to rebuild context", async () => {
  const calls = mockOpenAI({ verdict: "READY", report: "Qualified" });
  const result = await executeSkill("brief-qualifier", { contextPackage: "# Run Context Package" });
  assert.equal(result.verdict, "READY");
  assert.deepEqual(calls[0].body.tools[0].environment.skills.map(({ skill_id }) => skill_id), ["skill_qualifier"]);
  assert.match(calls[0].body.instructions, /do not request or rebuild context/);
});

test("standalone context-assembler calls keep the original instructions", async () => {
  const calls = mockOpenAI({ verdict: "LIMITED", report: "Package" });
  await executeSkill("context-assembler", { receivingStage: "brief-qualifier" });
  assert.doesNotMatch(calls[0].body.instructions, /contextPackage/);
});

test("a response cut off before finishing is reported clearly", async () => {
  mockOpenAI({ verdict: "READY", report: "x" }, { status: "incomplete" });
  await assert.rejects(executeSkill("post-writer", { contextPackage: "p" }, ["itemId", "text"]), /stopped before finishing/);
});
