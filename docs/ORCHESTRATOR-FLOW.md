# Optimised social content run (orchestrator flow)

## What changed

**Before:** Context Assembler ran before every skill. A run made 8 paid calls
(4 × Context Assembler + Brief Qualifier, Content Planner, Post Writer, QA), and every
Context Assembler call re-sent all of the brand knowledge.

**Now:** the Social Content Orchestrator runs Context Assembler **once** at the start of the
run. That one call returns four separate context packages (Brief Qualifier, Content Planner,
Post Writer, Post Quality Analyst). They are saved on the run (`runs.contextPackages`). Each
skill then runs with only its own package plus the same-run outputs it needs. A run now
makes 5 calls, and the knowledge is sent once.

| Step | Skills attached to the call | Input |
|---|---|---|
| 1. Assemble context (once) | `social-content-orchestrator` + `context-assembler` | brief, published knowledge, readiness |
| 2. Brief Qualifier | `brief-qualifier` | its package |
| 3. Content Planner | `content-planner` | its package + qualification |
| Gate 1: plan approval (unchanged) | | |
| 4. Post Writer | `post-writer` | its package + qualification + planner report + approved plan |
| 5. Post Quality Analyst | `post-quality-analyst` | its package + qualification + planner report + drafts + knowledge (needed for claim verification) |

Context Assembler is never called again between stages. The Post Writer and QA packages are
usually BLOCKED at assembly because the calendar and drafts don't exist yet. The call
returns `pendingDependenciesOnly: true` for those packages, and they don't block the run.
Any other BLOCKED package does block it.

Runs started before this change have no saved packages. When they reach drafting, the
missing packages are assembled once (Post Writer + QA only) and saved.

## Automatic QA fix rounds

When the Post Quality Analyst returns REVISE, the Post Writer rewrites the drafts with the QA
report (`qaFeedback`) and QA checks them again. This happens at most **2 times**
(`maxQaFixRounds`), for the first drafting and for every feedback regeneration. After that the
last QA result stands: PASS opens Gate 2; REVISE leaves the post as a draft with the QA note.
Each rewrite is its own stage execution (`attempt` 2, 3). The draft version keeps the final QA
result in `qaChecks` (unchanged) and adds `qaFixRounds` and `qaFixHistory` (earlier QA results).
A run with fix rounds makes up to 9 calls instead of 5.

## Roles

Brand roles are now `brand_manager`, `operator`, `approver` and `viewer` (were `knowledge_admin`
and `marketing_operator`). Run `MONGODB_URI=... node scripts/rename-roles.mjs` once before
deploying; it updates existing users and the `users` validator. Viewers can read every brand page
(runs, posts, knowledge, records, audit) and change nothing. Gate 1 has one reviewer: the
operator who owns the run, or the brand's named approver when the owner isn't an operator.

## Post review: feedback and regenerate

There is no approve or reject at post review any more:

- `POST /workflow/projects/:projectId/posts/:postId/regenerate` with body
  `{ currentDraftVersionId, feedback }` takes the reviewer's plain-language feedback. It
  queues a background job (in `writingJobs`, `kind: "regenerate"`, `_id: "<postId>:<draftVersion>"`).
  The job runs Post Writer and QA for that one post and saves a new draft version
  (`reviewerFeedback`, `regeneratedFromDraftVersionId`). If QA passes, it opens a new Gate 2
  review. While the job runs, `contentItems.regeneration.status` is `running`, and it ends as
  `completed` or `failed` (with `failureReason`).
- **Approve and schedule** is the existing Gate 2 decision `approved`, now accepting a future `scheduledAt` that is saved to `publishing.scheduledAt` (with step-up sign-in, QA and
  claim checks, all unchanged). Gate 2 no longer accepts `changes_requested` or `rejected`.
- Gate 1 (plan review) is unchanged.

All new fields fit the existing `b2b_agents` validators. No new collections, statuses or
stage keys. The assembly is recorded as one `context-assembler` stage execution with
`orchestrated: true` and `receivingStages`.

## Settings

Two new Render settings: `B2B_ORCHESTRATOR_SKILL_ID` and `B2B_ORCHESTRATOR_SKILL_VERSION`.
Upload all six skills from the optimised repo (`vaishu-vajra/B2B`, branch
`optimize-context-assembler`, folder `skills/`) with:

```
OPENAI_API_KEY=sk-... node scripts/upload-skills.mjs "<path>/skills"
```

It prints the 12 `B2B_*_SKILL_ID/_VERSION` settings to paste into Render.

## Tests

`npm test` runs offline checks on the orchestrator call, package handling and stage calls. It
mocks OpenAI and needs no database.

## Note for the team

`workflow-routes.js` registers `POST /workflow/projects/:projectId/runs` twice. Express only
uses the first one (the full agent workflow). The second one (the older qualification-only
flow using `qualification-skills.js`) never runs. It's left untouched here.
