# Skill Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One clean-room pi-subagents agent per third-party skills repo, generated from `repos.json` by a zero-dependency node tool (`install` / `update` / `status`), globally discoverable via one pi settings key.

**Architecture:** `scripts/generate.mjs` is a single-file, stdlib-only CLI that exports its core functions; `scripts/test.mjs` is an offline fixture-based harness importing them. The manifest (`repos.json`) is the source of truth; clones (`skills/`, gitignored) and generated agent files (`agents/`, committed) are derived. `install`/`update` regenerate both, prune orphans, and idempotently merge the pi settings key; `status` regenerates in memory and byte-compares.

**Tech Stack:** Node ≥ 18 (ESM, stdlib only: `node:fs`, `node:path`, `node:os`, `node:child_process`, `node:url`), git CLI via `spawnSync`. No npm dependencies, no package.json.

**Spec:** `docs/superpowers/specs/2026-07-09-skill-router-design.md` — the plan argues from the spec; read both.

## Global Constraints

- Node ≥ 18, ESM, **zero npm dependencies** — standard library only.
- Tests are **offline**: git operations exercised via `file://` bare-repo fixtures; no network in `scripts/test.mjs`.
- Generated output is byte-deterministic: LF line endings, one trailing `\n`, sorted pre-order directory walk, `skills:` line in discovery order.
- Manifest/agent names: `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 chars (pi's naming rules).
- Never commit clones (`.gitignore` has `/skills/`); generated `agents/*.md` **are** committed.
- `install` never mutates existing clones; `update` only ever runs `git pull --ff-only`.
- Exit codes: `install`/`update` exit non-zero if any entry failed; `status` exits 0 only if every entry is `ok` + `in-sync` (expected-absence rule for zero-skill entries).
- All exported functions take explicit paths/roots; `REPO_ROOT` (parent of `scripts/`) is only the CLI default — this is what makes the tool work from any cwd and makes tests hermetic.
- Skill-name corrupter rule: a declared skill name containing `,`, `:`, `"`, a newline, or surrounding whitespace cannot be expressed on the generated `skills:` line — skip that skill with a warning; keep the rest.
- `description` is always rendered as a YAML double-quoted string (`\` and `"` escaped); `persona` is markdown body, no escaping.

## Review Focus

Input classes the spec implies but no task's tests would otherwise exercise — each pinned to its owning task:

1. **CRLF line endings in upstream `SKILL.md` frontmatter** → the parsed name must not retain `\r`. (Task 3 test)
2. **A skill name that would corrupt the generated `skills:` line** (comma, colon, quotes) → warn + skip that skill; the rest of the repo still generates. (Task 3 test)
3. **`description` containing YAML-breaking characters** (`": "`, embedded quotes) → rendered frontmatter stays valid YAML. (Task 4 test)
4. **Unparseable `~/.pi/agent/settings.json`** → skip the merge with a warning; never overwrite or destroy the file. (Task 5 test)
5. **`skills/<name>/` exists but is not a git repo** (interrupted clone) → remove and re-clone. (Task 7 test)

---

### Task 1: Test harness, manifest loader, initial `repos.json`, CLI skeleton

**Files:**
- Create: `scripts/generate.mjs` (exports + CLI stub)
- Create: `scripts/test.mjs` (harness + manifest tests)
- Create: `repos.json` (all 10 entries, exact content below)
- Create: `install.sh` (pass-through wrapper)

**Interfaces:**
- Produces (used by every later task):
  - `export const REPO_ROOT` — absolute path of the repo root (`path.resolve(dirname(fileURLToPath(import.meta.url)), "..")`).
  - `export function loadManifest(root)` — returns `{ repos: RepoEntry[] }`; throws `Error` (message matching the failure) on: unparseable JSON, `repos` not an array, duplicate names (`duplicate name: <n>`), invalid name (`invalid name: <n>`), missing required field (`<name>: missing <field>`). `RepoEntry = { name, url, description, persona, skillSource?: string, pathExclude?: string[] }`.
  - Test helpers, defined at the top of `test.mjs`: `test(name, fn)` (registers), `eq(actual, expected, msg)` (strict-equal assert), `tmp()` (fresh `os.tmpdir()` dir), `w(root, rel, content)` (mkdir -p + write file), `clean(dir)` (rm -rf). `test.mjs` ends by running all registered tests sequentially, printing `PASS`/`FAIL <name>`, exit code 1 if any failed.

- [ ] **Step 1: Write `scripts/test.mjs` — harness + failing manifest tests**

Exact harness code (top of file; later tasks append tests above the runner):

```js
#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import * as gen from "./generate.mjs";

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function eq(a, e, msg) { assert.strictEqual(a, e, msg); }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "sr-")); }
function w(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function clean(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
```

Tests (append, then the runner):

```js
test("loadManifest returns entries with optional fields", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: "https://x/a", description: "d", persona: "p" },
    { name: "b", url: "https://x/b", description: "d", persona: "p",
      skillSource: ".pi/skills", pathExclude: ["skills/wip/**"] },
  ]}));
  const m = gen.loadManifest(root);
  eq(m.repos.length, 2);
  eq(m.repos[0].skillSource, undefined);
  eq(m.repos[1].skillSource, ".pi/skills");
  clean(root);
});

test("loadManifest rejects duplicate names", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: "u", description: "d", persona: "p" },
    { name: "a", url: "u2", description: "d", persona: "p" },
  ]}));
  assert.throws(() => gen.loadManifest(root), /duplicate name: a/);
  clean(root);
});

test("loadManifest rejects invalid names", () => {
  for (const bad of ["Bad_Name", "-x", "x-", "a--b", "a b"]) {
    const root = tmp();
    w(root, "repos.json", JSON.stringify({ repos: [
      { name: bad, url: "u", description: "d", persona: "p" }]}));
    assert.throws(() => gen.loadManifest(root), /invalid name/);
    clean(root);
  }
});

test("loadManifest rejects missing required fields", () => {
  for (const missing of ["url", "description", "persona"]) {
    const root = tmp();
    const entry = { name: "a", url: "u", description: "d", persona: "p" };
    delete entry[missing];
    w(root, "repos.json", JSON.stringify({ repos: [entry] }));
    assert.throws(() => gen.loadManifest(root), new RegExp(`a: missing ${missing}`));
    clean(root);
  }
});

process.exitCode = await (async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("PASS", t.name); }
    catch (e) { failed++; console.log("FAIL", t.name, "\n  " + e.message); }
  }
  console.log(failed ? `${failed} test(s) failed` : "all green");
  return failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs`
Expected: FAIL — `Cannot find module './generate.mjs'`

- [ ] **Step 3: Implement `scripts/generate.mjs` skeleton + `repos.json` + `install.sh`**

`generate.mjs`: imports (`node:fs`, `node:path`, `node:os`, `node:child_process`, `node:url`), `REPO_ROOT` per Interfaces, `loadManifest` (read `repos.json` under `root`, validate in order: parse → array → per-entry name regex `^[a-z0-9]+(-[a-z0-9]+)*$` and ≤64 → required fields → duplicate-name set), then a main guard:

```js
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cmd = process.argv[2];
  if (cmd === "install" || cmd === "update" || cmd === "status") {
    console.error(`${cmd}: not implemented yet`); process.exit(1);
  }
  console.error("usage: generate.mjs <install|update|status>"); process.exit(1);
}
```

`install.sh` (exact):

```bash
#!/usr/bin/env bash
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/scripts/generate.mjs" "$@"
```

`chmod +x install.sh`.

`repos.json` — exact content (this copy is a plan decision; tuning happens here later):

```json
{
  "repos": [
    {
      "name": "ponytail",
      "url": "https://github.com/DietrichGebert/ponytail",
      "description": "Blunt, opinionated senior-engineer persona",
      "persona": "You are Ponytail: a blunt, opinionated senior engineer with no patience for cargo-cult engineering or polite hedging. Name what is wrong, propose the simplest fix that works, and defend it with evidence from the code. Your skills define your working style — when a task matches one, read it and follow it."
    },
    {
      "name": "mattpocock",
      "url": "https://github.com/mattpocock/skills",
      "description": "Matt Pocock's engineering workflows: research, design, TDD, PRs",
      "pathExclude": ["skills/in-progress/**"],
      "persona": "You work the Matt Pocock way: think in types, design before coding, keep feedback loops tight. Your skills define your workflows for research, domain modeling, tickets, implementation, and review — when a task matches one, read it and follow it."
    },
    {
      "name": "i-have-adhd",
      "url": "https://github.com/ayghri/i-have-adhd",
      "description": "ADHD-friendly execution: smallest next step, visible progress, momentum",
      "persona": "You are an ADHD-friendly execution partner. Break work into the smallest next physical action, keep the plan visible, mark finished steps done out loud, and never leave a task ambiguous. Your skill defines how you work — read it and follow it."
    },
    {
      "name": "security-audit",
      "url": "https://github.com/cloudflare/security-audit-skill",
      "description": "Cloudflare's security-audit skill: threat-model and audit code",
      "persona": "You are a security auditor. Start from the threat model: who can reach this code, what they can influence, what they gain. Trace data from trust boundaries inward. Rank findings by exploitability, not scanner severity. Your skill defines the full audit procedure — read it and follow it."
    },
    {
      "name": "superpowers",
      "url": "https://github.com/obra/superpowers",
      "description": "Superpowers: brainstorm, spec, plan, TDD delivery discipline",
      "persona": "You work the Superpowers way: brainstorm before building, spec before plan, plan before code, test before implementation. Skills fire in order — using-superpowers first. When a task matches a skill's description, read it and follow it."
    },
    {
      "name": "diagram-design",
      "url": "https://github.com/cathrynlavery/diagram-design",
      "description": "Diagram design guidance for clear visual explanations",
      "persona": "You design diagrams that explain. Pick the diagram type from the relationship shown, label everything, and cut decoration that carries no information. Your skill defines your design rules — read it and follow it."
    },
    {
      "name": "humanizer",
      "url": "https://github.com/blader/humanizer",
      "description": "Rewrites AI-sounding prose so it reads like a person wrote it",
      "persona": "You are the Humanizer. Hunt AI tells — not-X-but-Y contrasts, one-line closers, staged openers, forced triads, dashes everywhere, inflated claims — and rewrite into plain, direct prose without changing meaning. Your skill defines the tell list and rewrite rules — read it and follow it."
    },
    {
      "name": "graphify",
      "url": "https://github.com/Graphify-Labs/graphify",
      "description": "Graphify — placeholder; upstream ships no skills yet",
      "persona": "You are the Graphify agent. The upstream repo ships no skills yet; this agent activates when it does. Until then, say so plainly when asked."
    },
    {
      "name": "addyosmani",
      "url": "https://github.com/addyosmani/agent-skills",
      "description": "Addy Osmani's engineering skills: architecture, performance, shipping",
      "persona": "You work in Addy Osmani's style: bias to shipping, performance as a feature, architecture in service of user value. Your skills cover planning, implementation, review, and launch — when a task matches one, read it and follow it."
    },
    {
      "name": "impeccable",
      "url": "https://github.com/pbakaus/impeccable",
      "description": "Impeccable: relentless polish toward near-perfect software",
      "skillSource": ".pi/skills",
      "persona": "You are Impeccable: you hunt the gap between works and right. Check what others skip — edge cases, error paths, copy, timing, accessibility — and fix it without being asked. Your skill defines your polish checklist — read it and follow it."
    }
  ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test.mjs`
Expected: 4× PASS, `all green`

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs repos.json install.sh
git commit -m "feat: manifest loader, test harness, initial 10-repo manifest, CLI skeleton"
```

---

### Task 2: Globstar matcher

**Files:**
- Modify: `scripts/generate.mjs`
- Modify: `scripts/test.mjs` (append tests)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function globToRegExp(pattern)` → `RegExp`. Translation: escape every character; `**` → `.*`; a lone `*` (after `**` replacement) → `[^/]*`; anchor `^…$`.

- [ ] **Step 1: Write the failing tests**

```js
test("globToRegExp: ** crosses segments, * does not", () => {
  const re = gen.globToRegExp("skills/in-progress/**");
  eq(re.test("skills/in-progress/a"), true);
  eq(re.test("skills/in-progress/a/b"), true);
  eq(re.test("skills/in-progressX/a"), false);
  const star = gen.globToRegExp("skills/*/one");
  eq(star.test("skills/a/one"), true);
  eq(star.test("skills/a/b/one"), false);
});

test("globToRegExp: literals are escaped", () => {
  eq(gen.globToRegExp("a.b/**").test("axb/c"), false);
  eq(gen.globToRegExp("a.b/**").test("a.b/c"), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs`
Expected: FAIL — `globToRegExp is not a function` (Task 1 tests still PASS)

- [ ] **Step 3: Implement `globToRegExp` in `scripts/generate.mjs`**

Approach: escape the whole pattern with a char-class escape (`[-[\]{}()*+?.,\\^$|#\s]` → `\\$&`), then replace the escaped form of `**` with `.*`, then remaining escaped `*` with `[^/]*`; wrap in `^…$`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test.mjs`
Expected: all PASS, `all green`

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: globstar matcher for pathExclude patterns"
```

---

### Task 3: Skill discovery

**Files:**
- Modify: `scripts/generate.mjs`
- Modify: `scripts/test.mjs` (append tests + `skill()` fixture helper)

**Interfaces:**
- Consumes: `globToRegExp` (Task 2), `RepoEntry`.
- Produces: `export function discoverSkills(cloneDir, entry)` → `{ skills: { name, dir }[], dropped: { name, keptDir, droppedDir }[], warnings: string[] }`.
  - Walk root: `path.join(cloneDir, entry.skillSource ?? ".")`. Pre-order traversal with `dirnames` sorted and pruned to skip: `node_modules`, `tests`, `test`, and dot-dirs. A directory containing `SKILL.md` is a skill candidate.
  - `pathExclude` patterns (if present) match the skill dir path relative to **cloneDir** (not the walk root); matches are dropped before name resolution.
  - Name resolution: file must start with `---` (BOM tolerated) or the skill is *malformed* → skipped + warning. Frontmatter = lines between the first `---` and the next `---`; take `name:` from it, trimming whitespace and `\r`. Absent/empty → fall back to the directory's basename.
  - Corrupter names (Global Constraints) → skipped + warning.
  - First-found (sorted pre-order) wins on name collisions; losers go to `dropped`.
  - `skills` and `dropped` preserve discovery order.
- Produces (test helper, used by Tasks 4, 6, 7): `function skill(root, rel, name)` in `test.mjs` — creates `<root>/<rel>/SKILL.md` with frontmatter `name: <name ?? basename(rel)>`, `description: test skill`, body `# body`.

- [ ] **Step 1: Write the failing tests**

```js
function skill(root, rel, name) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"),
    `---\nname: ${name ?? path.basename(rel)}\ndescription: test skill\n---\n# body\n`);
}

const E = (over = {}) => ({ name: "x", url: "u", description: "d", persona: "p", ...over });

test("discovery: names come from frontmatter, not dir names", () => {
  const root = tmp();
  skill(root, "skills/core");
  skill(root, "skills/renamed", "other-name");
  const r = gen.discoverSkills(root, E());
  eq(r.skills.map(s => s.name).sort().join(","), "core,other-name");
  clean(root);
});

test("discovery: nested subtrees, hidden dirs and tests/ are skipped", () => {
  const root = tmp();
  skill(root, "src/skills/deep/nested-one");
  skill(root, ".cursor/skills/hidden-one");
  skill(root, "tests/fixture/skills/test-one");
  const r = gen.discoverSkills(root, E());
  eq(r.skills.length, 1);
  eq(r.skills[0].name, "nested-one");
  clean(root);
});

test("discovery: empty repo and malformed SKILL.md", () => {
  const root = tmp();
  w(root, "not-a-skill.md", "no frontmatter here");
  w(root, "broken/SKILL.md", "name never on a --- line");
  const r = gen.discoverSkills(root, E());
  eq(r.skills.length, 0);
  eq(r.warnings.some(x => /broken/.test(x)), true);
  clean(root);
});

test("discovery: CRLF frontmatter name has no stray \\r", () => {
  const root = tmp();
  const dir = path.join(root, "crlf"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\r\nname: winuser\r\ndescription: d\r\n---\r\n");
  eq(gen.discoverSkills(root, E()).skills[0].name, "winuser");
  clean(root);
});

test("discovery: first sorted path wins collisions, loser reported", () => {
  const root = tmp();
  skill(root, "aaa/dup", "dup");
  skill(root, "zzz/dup", "dup");
  const r = gen.discoverSkills(root, E());
  eq(r.skills.length, 1);
  eq(r.dropped.length, 1);
  eq(/zzz/.test(r.dropped[0].droppedDir), true);
  clean(root);
});

test("discovery: pathExclude ** and * boundaries (spec fixtures)", () => {
  const root = tmp();
  skill(root, "skills/wip/a");
  skill(root, "skills/wip/deep/b");
  skill(root, "skills/keep/c");
  skill(root, "skills/a/one");
  skill(root, "skills/a/deep/one");
  const dd = gen.discoverSkills(root, E({ pathExclude: ["skills/wip/**", "skills/*/one"] }));
  eq(dd.skills.map(s => s.name).sort().join(","), "c,deep");
  clean(root);
});

test("discovery: skillSource narrows the walk root", () => {
  const root = tmp();
  skill(root, ".pi/skills/inner/only-here");
  skill(root, "skills/outside");
  const r = gen.discoverSkills(root, E({ skillSource: ".pi/skills" }));
  eq(r.skills.length, 1);
  eq(r.skills[0].name, "only-here");
  clean(root);
});

test("discovery: corrupter names are skipped with a warning", () => {
  const root = tmp();
  skill(root, "skills/bad", "a,b");
  skill(root, "skills/colon", "a:b");
  skill(root, "skills/good");
  const r = gen.discoverSkills(root, E());
  eq(r.skills.map(s => s.name).join(","), "good");
  eq(r.warnings.filter(x => /name/.test(x)).length, 2);
  clean(root);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs`
Expected: the 8 new discovery tests FAIL (`discoverSkills is not a function`); earlier tests PASS.

- [ ] **Step 3: Implement `discoverSkills` in `scripts/generate.mjs`**

Walk per Interfaces (collect candidates in sorted pre-order), apply `pathExclude` against the clone-relative dir path, resolve names, then one pass: first occurrence per name kept, later → `dropped`; malformed/corrupter → `warnings`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test.mjs`
Expected: all PASS, `all green`

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: skill discovery (frontmatter names, skips, collisions, pathExclude, skillSource)"
```

---

### Task 4: Agent rendering, generation, prune

**Files:**
- Modify: `scripts/generate.mjs`
- Modify: `scripts/test.mjs` (append tests)

**Interfaces:**
- Consumes: `loadManifest`, `discoverSkills`, `RepoEntry`.
- Produces:
  - `export function renderAgentFile(entry, skillNames)` → exact string:
    ```
    ---
    name: <entry.name>
    description: "<YAML-escaped entry.description>"
    inheritSkills: false
    skills: <names joined ", ">
    skillPath: ../skills/<entry.name>
    ---
    <entry.persona>
    ```
    One trailing newline; LF endings. YAML escape: `\` → `\\`, `"` → `\"`.
  - `export function writeAgentFiles(root, manifest)` → `{ written: string[], removed: string[] }`. For each entry: ≥1 skill → write `agents/<name>.md` with `renderAgentFile(entry, names)`; zero skills → delete a leftover `agents/<name>.md` if present and add `<name>` to `removed`. Warnings from discovery are returned for the caller to print — signature: `{ written, removed, warnings }`.
  - `export function prune(root, manifest)` → `{ agents: string[], clones: string[] }` — removes `agents/<name>.md` and `skills/<name>/` for every `<name>` present on disk but not in the manifest.

- [ ] **Step 1: Write the failing tests**

```js
test("renderAgentFile: exact bytes, YAML-escaped description", () => {
  const entry = { name: "ponytail", url: "u",
    description: `Blunt: says "no"`,
    persona: "You are Ponytail." };
  eq(gen.renderAgentFile(entry, ["ponytail", "ponytail-review"]),
`---
name: ponytail
description: "Blunt: says \\"no\\""
inheritSkills: false
skills: ponytail, ponytail-review
skillPath: ../skills/ponytail
---
You are Ponytail.
`);
});

test("writeAgentFiles: writes, idempotent, removes zero-skill leftovers", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "one", url: "u", description: "d", persona: "p" },
    { name: "zero", url: "u", description: "d", persona: "p" },
  ]}));
  skill(root, "skills/one/a");
  w(root, "agents/zero.md", "stale leftover");
  let r = gen.writeAgentFiles(root, gen.loadManifest(root));
  eq(r.written.join(","), "one");
  eq(r.removed.join(","), "zero");
  const first = fs.readFileSync(path.join(root, "agents/one.md"), "utf8");
  gen.writeAgentFiles(root, gen.loadManifest(root));
  eq(fs.readFileSync(path.join(root, "agents/one.md"), "utf8"), first);
  eq(fs.existsSync(path.join(root, "agents/zero.md")), false);
  clean(root);
});

test("prune: removes agents and clones not in the manifest", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "one", url: "u", description: "d", persona: "p" }]}));
  w(root, "agents/one.md", "keep");
  w(root, "agents/orphan.md", "drop");
  w(root, "skills/one/keep.txt", "keep");
  w(root, "skills/orphan/junk.txt", "drop");
  const r = gen.prune(root, gen.loadManifest(root));
  eq(r.agents.join(","), "orphan");
  eq(r.clones.join(","), "orphan");
  eq(fs.existsSync(path.join(root, "agents/one.md")), true);
  eq(fs.existsSync(path.join(root, "skills/orphan")), false);
  clean(root);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs`
Expected: the 3 new tests FAIL; earlier tests PASS.

- [ ] **Step 3: Implement `renderAgentFile`, `writeAgentFiles`, `prune`**

Per Interfaces. `writeAgentFiles` creates `agents/` with `mkdirSync(..., { recursive: true })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test.mjs`
Expected: all PASS, `all green`

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: deterministic agent file rendering, generation, orphan pruning"
```

---

### Task 5: Settings merge

**Files:**
- Modify: `scripts/generate.mjs`
- Modify: `scripts/test.mjs` (append tests)

**Interfaces:**
- Consumes: nothing (pure fs + JSON).
- Produces: `export function mergeSettings(settingsPath, repoRoot)` → `{ changed: boolean, entry: string, error?: string }`.
  - Entry value: if `repoRoot` is under `os.homedir()`, `<~>/<repoRoot relative to home>/agents`, else `<repoRoot>/agents` (absolute).
  - Settings file missing → create it containing only `{ "subagents": { "agentScanDirs": ["<entry>"] } }`; `changed: true`; no backup.
  - File exists and parses → append the entry to `subagents.agentScanDirs` (create the key/array if absent) unless an existing entry is equivalent (expand `~`, resolve, compare to the computed entry's resolved path); before any write, copy the original to `<settingsPath>.bak`. `changed: false` when already present (and no backup write).
  - File exists but is unparseable → `changed: false`, `error: "unparseable settings file, merge skipped"`, file untouched (Review Focus 4).

- [ ] **Step 1: Write the failing tests**

```js
test("mergeSettings: creates missing file with only the key", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const r = gen.mergeSettings(sp, path.join(os.homedir(), "repositories", "skill-router"));
  eq(r.changed, true);
  eq(r.entry, "~/repositories/skill-router/agents");
  const j = JSON.parse(fs.readFileSync(sp, "utf8"));
  eq(j.subagents.agentScanDirs.length, 1);
  clean(root);
});

test("mergeSettings: appends to existing, writes .bak, idempotent", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  w(root, "settings.json", JSON.stringify({ something: "else" }));
  const before = fs.readFileSync(sp, "utf8");
  const r1 = gen.mergeSettings(sp, root); // root NOT under home -> absolute entry
  eq(r1.changed, true);
  eq(r1.entry, path.join(root, "agents"));
  const j = JSON.parse(fs.readFileSync(sp, "utf8"));
  eq(j.something, "else");
  eq(j.subagents.agentScanDirs[0], path.join(root, "agents"));
  eq(fs.readFileSync(sp + ".bak", "utf8"), before);
  const r2 = gen.mergeSettings(sp, root);
  eq(r2.changed, false);
  eq(JSON.parse(fs.readFileSync(sp, "utf8")).subagents.agentScanDirs.length, 1);
  clean(root);
});

test("mergeSettings: equivalent ~ entry means already configured", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const repoRoot = path.join(os.homedir(), "repositories", "skill-router");
  w(root, "settings.json", JSON.stringify(
    { subagents: { agentScanDirs: [repoRoot + "/agents"] } }));
  const r = gen.mergeSettings(sp, repoRoot);
  eq(r.changed, false);
  clean(root);
});

test("mergeSettings: unparseable file is never touched", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  w(root, "settings.json", "{ not json !!!");
  const before = fs.readFileSync(sp, "utf8");
  const r = gen.mergeSettings(sp, root);
  eq(r.changed, false);
  eq(/unparseable/.test(r.error), true);
  eq(fs.readFileSync(sp, "utf8"), before);
  eq(fs.existsSync(sp + ".bak"), false);
  clean(root);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs`
Expected: the 4 new tests FAIL; earlier tests PASS.

- [ ] **Step 3: Implement `mergeSettings`**

Per Interfaces. `~` expansion helper: `p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test.mjs`
Expected: all PASS, `all green`

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: idempotent agentScanDirs settings merge with .bak backup"
```

---

### Task 6: `status` command

**Files:**
- Modify: `scripts/generate.mjs`
- Modify: `scripts/test.mjs` (append tests + `gitRepo()` helper)

**Interfaces:**
- Consumes: `loadManifest`, `discoverSkills`, `renderAgentFile`, `prune` (no — status is read-only, does not prune).
- Produces:
  - `export function cloneState(cloneDir)` → `"missing" | "not-a-repo" | "dirty" | "ok"`. missing: dir absent; not-a-repo: no `.git` dir; dirty: `git -C <dir> status --porcelain` exits 0 with non-empty stdout; else ok.
  - `export function statusOf(root, manifest)` → `{ rows: { name, clone, skills, agent }[], exitCode: 0|1 }`. Per entry: `skills` = discovered count; agent state: zero skills → file absent ⇒ `in-sync`, present ⇒ `stale`; ≥1 skill → file absent ⇒ `missing`; present but bytes ≠ `renderAgentFile` ⇒ `stale`; else `in-sync`. `exitCode` 0 iff every row is `clone === "ok"` and `agent === "in-sync"`.
  - CLI: wire the `status` branch in the main guard — print `NAME`/`CLONE`/`SKILLS`/`AGENT` header, rows via `padEnd(14/10/7)` + state, exit with `statusOf`'s code.
- Test helper (used by Task 7 too): `function gitRepo(dir)` in `test.mjs` — `git init -q`, local `user.name`/`user.email` config, initial empty commit (`git commit --allow-empty -m init -q`).

- [ ] **Step 1: Write the failing tests**

```js
function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g("init", "-q");
  g("config", "user.name", "t"); g("config", "user.email", "t@t");
  g("add", "-A");
  g("commit", "--allow-empty", "-m", "init", "-q");
}

test("status: exit rules incl. expected absence for zero-skill entries", () => {
  const root = tmp();
  const manifest = { repos: [
    { name: "one", url: "u", description: "d", persona: "p" },
    { name: "zero", url: "u", description: "d", persona: "p" },
  ]};
  w(root, "repos.json", JSON.stringify(manifest));
  gitRepo(path.join(root, "skills/one"));
  skill(root, "skills/one/a");
  w(root, "agents/one.md", gen.renderAgentFile(manifest.repos[0], ["a"]));
  gitRepo(path.join(root, "skills/zero"));           // clone ok, no skills
  const r = gen.statusOf(root, manifest);
  eq(r.rows.length, 2);
  eq(r.rows.find(x => x.name === "zero").agent, "in-sync");
  eq(r.rows.find(x => x.name === "one").agent, "in-sync");
  eq(r.exitCode, 0);
  clean(root);
});

test("status: stale, missing, dirty, not-a-repo, missing-clone all flagged", () => {
  const root = tmp();
  const manifest = { repos: [
    { name: "stale", url: "u", description: "d", persona: "p" },
    { name: "nofile", url: "u", description: "d", persona: "p" },
    { name: "dirty", url: "u", description: "d", persona: "p" },
    { name: "fake", url: "u", description: "d", persona: "p" },
    { name: "gone", url: "u", description: "d", persona: "p" },
  ]};
  w(root, "repos.json", JSON.stringify(manifest));
  for (const n of ["stale", "nofile", "dirty"]) { skill(root, `skills/${n}/a`); }
  gitRepo(path.join(root, "skills/stale"));
  w(root, "agents/stale.md", "tampered");
  gitRepo(path.join(root, "skills/nofile"));
  gitRepo(path.join(root, "skills/dirty"));
  w(root, "skills/dirty/untracked.txt", "x");
  w(root, "skills/fake/junk.txt", "x");           // dir, no .git
  const r = gen.statusOf(root, manifest);
  const by = n => r.rows.find(x => x.name === n);
  eq(by("stale").agent, "stale"); eq(by("stale").clone, "ok");
  eq(by("nofile").agent, "missing");
  eq(by("dirty").clone, "dirty");
  eq(by("fake").clone, "not-a-repo");
  eq(by("gone").clone, "missing");
  eq(r.exitCode, 1);
  clean(root);
});
```

(`spawnSync` needs an import at the top of `test.mjs`: `import { spawnSync } from "node:child_process";`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs`
Expected: the 2 new tests FAIL; earlier tests PASS.

- [ ] **Step 3: Implement `cloneState` and `statusOf`, wire the `status` CLI branch**

- [ ] **Step 4: Run tests + a live CLI check**

Run: `node scripts/test.mjs`
Expected: all PASS, `all green`
Run: `./install.sh status`
Expected: table printed for the real manifest — clone `missing` for all 10 (nothing cloned yet), exit 1. Confirms CLI wiring + real-root resolution.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: status command with expected-absence semantics"
```

---

### Task 7: `install` + `update` orchestration

**Files:**
- Modify: `scripts/generate.mjs`
- Modify: `scripts/test.mjs` (append tests + `bareRemote()` helper)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `export function runInstall(root, settingsPath = path.join(os.homedir(), ".pi/agent/settings.json"))` → `{ exitCode: 0|1, report: string[] }`; `export function runUpdate(root, settingsPath = …)` same shape. The CLI branches print `report` lines and exit with `exitCode`.
  - Flow (install): `loadManifest` → per entry (file order) clone state machine: missing → `git clone --depth 1 <url> <skills/name>`; not-a-repo → rm + re-clone; git repo → reuse (report `reused` / `reused (dirty)`); clone failure → report `clone failed`, mark failed, continue. Then `discoverSkills` (print warnings), `writeAgentFiles`, `prune` (report `pruned <name>` lines), `mergeSettings` (report `settings: added <entry>` / `settings: already configured` / `settings: skipped (unparseable)`), summary lines `<name>: <cloned|reused|reused (dirty)>, N skills, agent written` or `<name>: 0 skills, no agent`. `exitCode` 1 iff any clone failed.
  - Flow (update): first parse each existing `agents/<name>.md` frontmatter `skills:` line into an old name set; then per entry pull `git pull --ff-only` (failure → report `pull failed (left as-is)`, keep going); then identical to install, with per-entry delta lines when the set changed: `<name>: +<A> (…), -<R> (…)` (omit empty halves).
  - Test helper: `function bareRemote(root)` in `test.mjs` — returns `{ url, add(rel, name) }`: creates `<root>/remote.git` (bare) + `<root>/work` clone; `add` writes a skill in `work`, commits, pushes (`git -C work push -q origin`), so tests can evolve the remote offline. Use `file://` absolute URL. Run `git -C <work> config user.name/email` before the first commit.

- [ ] **Step 1: Write the failing tests**

```js
function bareRemote(root) {
  const url = "file://" + path.join(root, "remote.git");
  spawnSync("git", ["init", "-q", "--bare", path.join(root, "remote.git")]);
  const work = path.join(root, "work");
  spawnSync("git", ["clone", "-q", url, work]);
  const g = (...a) => spawnSync("git", ["-C", work, ...a], { encoding: "utf8" });
  g("config", "user.name", "t"); g("config", "user.email", "t@t");
  return { url, add(rel, name) {
    skill(work, rel, name);
    g("add", "-A"); g("commit", "-q", "-m", "add"); g("push", "-q", "origin", "HEAD");
  } };
}

test("install: clones, generates, prunes, merges settings; clone failure flagged", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" },
    { name: "b", url: "file://" + path.join(root, "nope.git"), description: "d", persona: "p" },
  ]}));
  w(root, "agents/orphan.md", "drop me");
  const r = gen.runInstall(root, sp);
  eq(r.exitCode, 1);                                    // entry b failed
  eq(fs.existsSync(path.join(root, "skills/a/skills/one/SKILL.md")), true);
  eq(fs.readFileSync(path.join(root, "agents/a.md"), "utf8"),
     gen.renderAgentFile({ name: "a", description: "d", persona: "p" }, ["one"]));
  eq(fs.existsSync(path.join(root, "agents/orphan.md")), false);
  eq(JSON.parse(fs.readFileSync(sp, "utf8")).subagents.agentScanDirs[0],
     path.join(root, "agents"));
  eq(r.report.some(l => /clone failed/.test(l)), true);
  clean(root);
});

test("install: not-a-repo clone dir is removed and re-cloned", () => {
  const root = tmp(); const remote = bareRemote(root);
  remote.add(path.join("skills", "one"), "one");
  w(root, "skills/a/junk.txt", "interrupted clone");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" }]}));
  const r = gen.runInstall(root, path.join(root, "settings.json"));
  eq(r.exitCode, 0);
  eq(fs.existsSync(path.join(root, "skills/a/.git")), true);
  eq(fs.existsSync(path.join(root, "skills/a/junk.txt")), false);
  clean(root);
});

test("update: pull --ff-only picks up new skills and reports deltas", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" }]}));
  eq(gen.runInstall(root, sp).exitCode, 0);
  remote.add(path.join("skills", "two"), "two");
  const r = gen.runUpdate(root, sp);
  eq(r.exitCode, 0);
  eq(r.report.some(l => /a: \+1 \(two\)/.test(l)), true);
  eq(fs.readFileSync(path.join(root, "agents/a.md"), "utf8"),
     gen.renderAgentFile({ name: "a", description: "d", persona: "p" }, ["one", "two"]));
  clean(root);
});

test("update: non-ff remote is warned and left as-is, exit non-zero", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" }]}));
  eq(gen.runInstall(root, sp).exitCode, 0);
  // rewrite remote history: amend + force push makes local pull non-ff
  spawnSync("git", ["-C", path.join(root, "work"), "commit", "--amend", "-q", "-m", "rewritten"]);
  spawnSync("git", ["-C", path.join(root, "work"), "push", "-q", "-f", "origin", "HEAD"]);
  const r = gen.runUpdate(root, sp);
  eq(r.exitCode, 1);
  eq(r.report.some(l => /pull failed/.test(l)), true);
  eq(fs.existsSync(path.join(root, "skills/a/.git")), true);   // clone untouched
  clean(root);
});

test("install: reused clone reported dirty when locally modified", () => {
  const root = tmp(); const remote = bareRemote(root);
  remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" }]}));
  gen.runInstall(root, path.join(root, "settings.json"));
  w(root, "skills/a/local-change.txt", "x");
  const r = gen.runInstall(root, path.join(root, "settings.json"));
  eq(r.report.some(l => /reused \(dirty\)/.test(l)), true);
  eq(r.exitCode, 0);
  clean(root);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs`
Expected: the 5 new tests FAIL; earlier tests PASS.

- [ ] **Step 3: Implement `runInstall` and `runUpdate`, wire their CLI branches**

Git via `spawnSync("git", […], { encoding: "utf8" })`. Pull old skill sets by reading the pre-update `agents/<name>.md` `skills:` frontmatter line (split `", "`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test.mjs`
Expected: all PASS, `all green`

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: install/update orchestration with deltas, prune, settings wiring"
```

---

### Task 8: Real install, README, commit agents, first-run assumption checks

**Files:**
- Create: `README.md`
- Create (generated, then commit): `agents/*.md` (9 files)
- Modify: `docs/superpowers/specs/2026-07-09-skill-router-design.md` (record assumption-check outcomes in "Assumptions to validate on first run")

**Interfaces:**
- Consumes: the finished CLI; the real `repos.json`.

- [ ] **Step 1: Full test suite + real install**

Run: `node scripts/test.mjs` → `all green`.
Run: `./install.sh install`
Expected: 10 entries processed; 9 agents written; `graphify: 0 skills, no agent`; settings report `added ~/repositories/skill-router/agents` (or `already configured`); exit 0.

- [ ] **Step 2: Spot-check generated agents against the spec's roster table**

Check `agents/humanizer.md` (root-`SKILL.md` case: `skills: humanizer`), `agents/impeccable.md` (`skills: impeccable`, one skill despite ~24 copies), `agents/mattpocock.md` (31 skills, none from `skills/in-progress/`), `agents/ponytail.md` (6 skills, no `.openclaw` duplicates). Verify `skills/` is untracked (`git status` clean of `skills/`).

- [ ] **Step 3: Write `README.md`**

Sections: what this is (one clean-room agent per skills repo); quickstart (`./install.sh install|update|status`, then `/reload` in pi); how it works (manifest → clones → generated agents → `subagents.agentScanDirs`); tuning (edit `repos.json` `description`/`persona`/`skillSource`/`pathExclude`, rerun `./install.sh update`); safety (settings `.bak` written, clones gitignored, prune removes orphans); uninstall (remove `agents/` dir + the settings entry).

- [ ] **Step 4: Commit generated agents + README**

```bash
git add agents/ README.md
git commit -m "feat: generated agents for verified roster + README"
```

- [ ] **Step 5: First-run assumption checks (spec section) + commit**

Launch a generated agent with a trivial task, e.g. subagent `diagram-design`, task: "Reply with the exact list of skill names available to you and nothing else." Expected: only `diagram-design`. If the launch reports the agent as unknown, the parent session's catalog predates the settings change — ask the user to run `/reload` and retry. Record the outcome of all four assumptions (scan-dir `skillPath` resolution, clean-room no-bleed, missing-skill-name tolerance, collision semantics) with the date in the spec's "Assumptions to validate on first run" section, then:

```bash
git add docs/superpowers/specs/2026-07-09-skill-router-design.md
git commit -m "docs: first-run assumption check results"
```
