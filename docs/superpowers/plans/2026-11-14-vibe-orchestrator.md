# Vibe Orchestrator Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a Vibe workflow-orchestrator mode TOML (`agents-vibe/workflow-orchestrator.toml`) that runs workflows on Vibe, per ADR-010.

**Architecture:** A new `renderVibeOrchestratorTOML(workflows)` bakes the workflow list into a mode TOML (`agent_type = "agent"`) at generation time — no runtime manifest discovery. `runFlow` writes it when `workflows.json` is valid and removes a stale one when it is not, mirroring the manifest-prune philosophy. The mode dispatches step agents via the spawn tool, writes output files itself from subagent replies, and checkpoints via `ask_user_question`.

**Tech Stack:** Node.js ≥ 18 ESM, no new dependencies. Existing patterns: `renderVibeAgentTOML`/`writeVibeRouterAgent` in `scripts/generate.mjs`, `manifestState` in `scripts/workflows.mjs`, TOML escaping via `tomlEscape`/`normalizeText`.

**Spec:** `docs/decisions/ADR-010-vibe-orchestrator-mode.md`

## Global Constraints

- No new npm dependencies; Node ≥ 18 built-ins only.
- `agent_type = "agent"` (the enum has only `agent`/`subagent` — probed).
- `disabled_tools = ["skill"]` always; the mode's tool set: read, write, spawn (`task`), and `ask_user_question` — exact spellings per ADR-010's probe.
- Workflow list baked into instructions at generation time; no runtime read of `workflows.json`.
- Absent or malformed `workflows.json` → the mode is not written; a stale `workflow-orchestrator.toml` is removed (prune philosophy).
- No `config.toml` changes (ADR-004 respected by omission — `agent_paths` already loads `agents-vibe/`).
- Step agents keep their ADR-006 read-only allowlists; the orchestrator is the single writer.

## Review Focus

- Generated TOML must be valid TOML the Vibe loader accepts: `agent_type = "agent"`, no stray `"""` from unescaped task text (task text passes through `tomlEscape(normalizeText(...))`).
- Stale-mode removal must never delete a user-authored file: only remove when the existing file's content is byte-identical to what a previous generation would have written (compare against a re-render from the same inputs is impossible once the manifest changed — instead remove only when the file carries skill-router's generated marker line, mirroring the agents-claude ownership pattern).
- Bake correctness: every workflow in `workflows.json` appears in the instructions with name, description, each step's agent, task, and output.
- Missing agent TOML: a workflow referencing an agent whose `agents-vibe/<name>.toml` was pruned (repo removed) — the mode still names it; dispatch fails at runtime. Accept (the validator already guarantees the name is in `repos.json`) and note it in the instructions ("if a spawn fails, stop and say so").
- `runFlow` ordering: the mode is written after `writeVibeRouterAgent` and inside the same `wfState` validation pass — no extra manifest parse.

---

### Task 1: `renderVibeOrchestratorTOML` + tests

**Files:**
- Modify: `scripts/generate.mjs` (new export beside `renderVibeAgentTOML`)
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `manifestState` from `scripts/workflows.mjs` (already imported), `tomlEscape`, `normalizeText` from `scripts/generate.mjs`'s existing helpers, `VIBE_BOILERPLATE`.
- Produces: `export function renderVibeOrchestratorTOML(workflows)` → string (full TOML file content). `workflows` is the array from `manifestState().workflows` — entries `{ name, description, steps: [{ agent, task, output }] }`.

- [ ] **Step 1: Write the failing tests**

```js
test("renderVibeOrchestratorTOML emits a mode TOML with baked workflows", () => {
  const toml = gen.renderVibeOrchestratorTOML([
    { name: "design-review", description: "d", steps: [
      { agent: "superpowers", task: "Brainstorm the feature", output: "docs/design.md" },
      { agent: "ponytail", task: "Critique it", output: "docs/design-review.md" } ] },
  ]);
  assert(/agent_type = "agent"/.test(toml));
  assert(/disabled_tools = \["skill"\]/.test(toml));
  assert(/ask_user_question/.test(toml) && /task/.test(toml) && /write_file/.test(toml));
  assert(toml.includes("design-review"));
  assert(toml.includes("Brainstorm the feature"));   // task text baked, escaped
  assert(toml.includes("docs/design.md"));
  assert(/checkpoint/i.test(toml));                   // ADR-009 contract in prose
  assert(/already exists and is non-empty/.test(toml)); // resume rule
  // every workflow and step appears; no bare """ breakage from quotes in task text
  const weird = gen.renderVibeOrchestratorTOML([
    { name: "w", description: 'say "hi"', steps: [
      { agent: "a", task: 'write "quoted" text', output: "docs/o.md" } ] }]);
  assert(weird.includes('\\"quoted\\"') || !weird.includes('"""')); // escaped or at least unbroken
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs` — Expected: FAIL, `renderVibeOrchestratorTOML is not a function`.

- [ ] **Step 3: Implement**

TOML shape (follow `renderVibeAgentTOML`'s line-array style): `agent_type = "agent"`, `description = "Run multi-agent workflows: dispatch each step, verify outputs, checkpoint between steps"`, `enabled_tools = ["read_file", "write_file", "task", "ask_user_question"]`, `disabled_tools = ["skill"]`, then `instructions = """` with: the orchestrator persona (one paragraph stating its single job); the numbered run contract (spawn step agent with task text via the spawn tool → wait for the reply → write the step's output file from the reply with write_file → verify non-empty → ask_user_question checkpoint before the next step → stop and report on any failure, never guess a substitute agent); the resume rule (skip steps whose output exists and is non-empty); then one block per workflow: name, description, and each step as `step N: agent <name> — task: <task> — output: <output>`; a generated-marker comment line (`# skill-router: generated — safe to prune`) at the top for ownership checks.

- [ ] **Step 4: Run tests to verify they pass** — `node scripts/test.mjs` → all green.

- [ ] **Step 5: Commit** — `git add scripts/generate.mjs scripts/test.mjs && git commit -m "feat: renderVibeOrchestratorTOML with baked workflow list"`

---

### Task 2: Generation wiring + stale prune

**Files:**
- Modify: `scripts/generate.mjs` (`writeVibeOrchestrator(root, wfState)` + call in `runFlow`)
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `renderVibeOrchestratorTOML` (Task 1), `wfState` already computed in `runFlow` (PR #24's single-validation pass).
- Produces: `writeVibeOrchestrator(root, wfState)` → `{ written: boolean, removed: boolean }`; called from `runFlow` after `writeVibeRouterAgent`.

- [ ] **Step 1: Write the failing tests**

```js
test("writeVibeOrchestrator writes the mode for a valid manifest, removes it when the manifest goes bad", () => {
  // tmp root: repos.json + valid workflows.json → writeVibeOrchestrator writes
  //   agents-vibe/workflow-orchestrator.toml containing the workflow name
  // then malformed workflows.json → returns { removed: true }, file gone
  // then absent workflows.json → still gone, no error
});
test("writeVibeOrchestrator never removes a user-authored file", () => {
  // tmp root: agents-vibe/workflow-orchestrator.toml WITHOUT the generated
  // marker line + absent workflows.json → file untouched, removed: false
});
```

- [ ] **Step 2: Run tests to verify they fail** — expected FAIL, function missing.

- [ ] **Step 3: Implement**

`writeVibeOrchestrator(root, wfState)`: if `wfState.valid && wfState.workflows.length > 0` → mkdir agents-vibe, `atomicWrite` the render. Else: if the file exists AND its first lines contain the generated marker → `fs.rmSync`, return removed; if it exists without the marker → leave it (user-authored), report via return value. Wire into `runFlow` beside `writeVibeRouterAgent(root, anchor)`, reusing the existing `wfState` — no new manifest parse. Push a report line (`vibe orchestrator mode: written|removed|skipped`).

- [ ] **Step 4: Run tests to verify they pass** — all green (existing runFlow/install tests must stay green).

- [ ] **Step 5: Commit** — `git commit -m "feat: wire Vibe orchestrator mode generation with stale prune"`

---

### Task 3: README + lockstep documentation

**Files:**
- Modify: `README.md` (Workflows section Vibe paragraph; the lockstep duty sentence)
- Test: none (docs) — but verify the real generation: run `node scripts/generate.mjs` (or the repo's generation entry) and confirm `agents-vibe/workflow-orchestrator.toml` renders with all three workflows.

- [ ] **Step 1: Update the Vibe paragraph** — replace "A generated Vibe orchestrator agent may follow later." with: on Vibe, select the `workflow-orchestrator` mode (`--agent workflow-orchestrator` or Shift+Tab); it dispatches each step's agent, writes the outputs, and checkpoints between steps — the same contract as the pi and Claude skills. Note it is regenerated on install/update and that writes prompt for approval. Add one sentence naming the three-runner lockstep duty, linking ADR-010.

- [ ] **Step 2: Verify generation renders** — run the generation step and confirm the committed `agents-vibe/workflow-orchestrator.toml` (if generation commits its outputs) contains `design-review`, `security-review`, `research-to-verdict`.

- [ ] **Step 3: Commit** — `git commit -m "docs: Vibe workflow-orchestrator mode usage and lockstep duty"`
