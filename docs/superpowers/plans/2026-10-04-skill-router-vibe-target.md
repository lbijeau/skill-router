# Skill Router — Vibe Output Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate one Mistral Vibe subagent TOML per manifest repo (clean-room: exactly that repo's skills, nothing from the user's catalog) and wire Vibe discovery + read permissions, alongside the untouched pi target.

**Architecture:** A second derived output target in the existing single-file generator. The same `discoverSkills` result feeds a new TOML renderer (`disabled_tools = ["skill"]` seals the catalog route; an embedded skill table with absolute `SKILL.md` paths grants the file route). A new `mergeVibeConfig` does line-wise TOML edits with a strict safety envelope (two easy cases, refuse the rest, `.bak` first, actionable bail). `prune`, `statusOf`, and `runFlow` extend to cover the new target.

**Tech Stack:** Node ≥ 18, standard library only, zero npm dependencies. Tests: the existing registration-style harness in `scripts/test.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-04-skill-router-vibe-design.md` (the plan argues from the spec; executors read both).

## Global Constraints

- Node ≥ 18 standard library only; no new dependencies, no new files outside `scripts/`, `agents-vibe/` (generated), `docs/`, `README.md`.
- pi target output bytes do not change: existing tests must pass unmodified. `agents/<name>.md` rendering is untouched.
- All paths in generated Vibe artifacts are absolute (`os.homedir()`-expanded where relevant); no `~` in config entries or TOML content.
- Generated boilerplate is a machine-independent constant; the marker sentence is exactly: `You have no skill tool; if one is offered anyway, do not use it.`
- Description truncation is deterministic: normalize (collapse whitespace, strip control chars, tab → space); if > 240 chars, truncate at the first sentence boundary (`. `, `! `, `? `) whose punctuation index is < 240 (keep the punctuation, drop the trailing space); if none, drop from the last space whose index is < 240 onward and append `…` (the space is dropped); if no space either, hard-cut at 240 and append `…`.
- `agents-vibe/*.toml` is generated and committed (same convention as `agents/`). No "generated" marker inside files.
- Tests follow the existing harness: `test()`, `eq()`, `assert.throws`, `tmp()`, `w()`, `clean()`, `skill()`, `E()`; full suite runs via `node scripts/test.mjs` and must end `all green`.
- Every task's test run is the full suite (fast, offline) unless the step says otherwise.

## Review Focus

Input classes the spec implies but that no ordinary happy-path test would exercise — each pinned by a test in the owning task:

1. A folded `description: >` block whose content contains a `name:` line — name resolution must be unchanged (Task 1).
2. Persona containing `"""` or `"` at the end — the multi-line basic string must survive verbatim with no unescaped `"""` sequence in the body (Task 2).
3. `agent_paths` defined inside a sub-table (`[foo]`) — must never be edited or merged into; top-level key inserted instead (Task 4).
4. A multi-line `agent_paths` array or any `"""`/`'''` in config.toml — safe-bail, file untouched, warning contains the exact line to add manually (Task 4).
5. Zero-skill entry with a leftover TOML — status `stale` and exit 1, not the `—` expected-absence mark (Task 7).

---

### Task 1: Description parsing in discovery

**Files:**
- Modify: `scripts/generate.mjs` (frontmatter parsing in `discoverSkills`, new export)
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `discoverSkills(cloneDir, entry)` (existing), existing name-resolution semantics.
- Produces: `export function parseSkillFrontmatter(content) -> { closed: boolean, name: string | null, description: string | null }` and each skill ref in `discoverSkills(...).skills` gains `description: string | null` (normalized, truncated, or `null`). Later tasks render `ref.description`; `null` means name-only rows.

- [ ] **Step 1: Commit the spec first (it is currently uncommitted)**

```bash
git add docs/superpowers/specs/2026-10-04-skill-router-vibe-design.md
git commit -m "docs: vibe output target design spec"
```

- [ ] **Step 2: Write failing tests**

Add to `scripts/test.mjs` (alongside the existing discovery tests; reuse `E()`, `skill()`, `w()`, `tmp()`, `clean()`):

```js
test("parseSkillFrontmatter: single-line, quoted, folded, literal, missing", () => {
  const f = (desc) => gen.parseSkillFrontmatter(`---\nname: a\n${desc}\n---\n`);
  eq(f("description: plain text").description, "plain text");
  eq(f('description: "quoted text"').description, "quoted text");
  eq(f("description: >\n  folded one\n  folded two").description, "folded one folded two");
  eq(f("description: |-\n  lit one\n  lit two").description, "lit one lit two");
  eq(f("description:").description, null);
  eq(f("description: >\n  win").name, "a");   // closed detection still works
  eq(gen.parseSkillFrontmatter("---\nname: a\n").closed, false);
});

test("parseSkillFrontmatter: folded block containing a name: line keeps name resolution", () => {
  const r = gen.parseSkillFrontmatter(
    "---\ndescription: >\n  name: not-a-name\n  more text\nname: real\n---\n");
  eq(r.name, "real");
  eq(r.description, "name: not-a-name more text");
});

test("parseSkillFrontmatter: truncation at 240 (sentence, word, hard branches)", () => {
  const long = "word ".repeat(80).trim();                       // 399 chars, no punctuation
  const sent = "First sentence. " + long;                       // sentence boundary < 240
  const f = (d) => gen.parseSkillFrontmatter(`---\nname: a\n${d}\n---\n`);
  eq(f("description: " + sent).description, "First sentence.");
  // last space with index < 240 is at 239; the space itself is dropped
  eq(f("description: " + long).description, long.slice(0, 239) + "…");
  const noSpace = "x".repeat(300);
  const h = f("description: " + noSpace).description;
  eq(h.length, 241); eq(h.startsWith("x".repeat(240)), true); eq(h.endsWith("…"), true);
});

test("parseSkillFrontmatter: CRLF description carries no \\r", () => {
  const r = gen.parseSkillFrontmatter("---\r\nname: a\r\ndescription: d\r\n---\r\n");
  eq(r.description, "d");
});

test("discovery: refs carry normalized description", () => {
  const root = tmp();
  skill(root, "skills/one");                                   // fixture writes "description: test skill"
  const r = gen.discoverSkills(root, E());
  eq(r.skills[0].description, "test skill");
  clean(root);
});
```

- [ ] **Step 3: Run the suite to verify the new tests fail**

Run: `node scripts/test.mjs`
Expected: FAIL on the new tests (`parseSkillFrontmatter is not a function`); all existing tests PASS.

- [ ] **Step 4: Implement `parseSkillFrontmatter` and wire it into `discoverSkills`**

In `scripts/generate.mjs`: implement `parseSkillFrontmatter(content)` per the Global Constraints truncation rule; it reuses the current BOM-strip and `---` detection logic. Refactor the inline loop in `discoverSkills` to call it — the name/warning/dropped behavior is preserved and pinned by the existing tests (hijack, unclosed, CRLF, collisions). Block scalars: after a `description:` line whose value matches `/^[|>](?:[0-9]+[+-]?|[+-][0-9]+)?$/`, consume following lines while they are indented (`/^\s/`) or blank, joining their trimmed values with single spaces; a folded block stops at the closing `---`. Quote-stripping: remove one pair of matching surrounding `"` or `'`. Store `description` on each ref (`null` when absent/empty).

- [ ] **Step 5: Run the full suite**

Run: `node scripts/test.mjs`
Expected: `all green` — new tests pass and every pre-existing test passes unmodified (pi bytes unchanged).

- [ ] **Step 6: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: parse skill descriptions (block scalars, deterministic truncation)"
```

### Task 2: `renderVibeAgentTOML`

**Files:**
- Modify: `scripts/generate.mjs`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: skill refs `{ name, dir, description }` from Task 1; manifest `entry` (`description`, `persona`).
- Produces: `export const VIBE_MARKER` (the exact marker sentence from Global Constraints); `export const VIBE_BOILERPLATE` (the four boilerplate sentences, one per line, first line = `VIBE_MARKER`); `export function renderVibeAgentTOML(entry, skills) -> string` where `skills` is an array of `{ name, dir, description }` refs. Later tasks byte-compare against this function's output.

- [ ] **Step 1: Write failing tests**

```js
test("renderVibeAgentTOML: exact bytes, one skill with description", () => {
  const entry = { name: "x", description: `Says "no"`, persona: "You are X." };
  const dir = "/abs/root/skills/x/core";
  eq(gen.renderVibeAgentTOML(entry, [{ name: "core", dir, description: "does things" }]),
`agent_type = "subagent"
description = "Says \\"no\\""
disabled_tools = ["skill"]
instructions = """
You are X.

${gen.VIBE_BOILERPLATE}

- core: does things — /abs/root/skills/x/core/SKILL.md
"""
`);
});

test("renderVibeAgentTOML: name-only row when description null, multiple rows", () => {
  const entry = { name: "x", description: "d", persona: "p" };
  const out = gen.renderVibeAgentTOML(entry, [
    { name: "a", dir: "/r/a", description: null },
    { name: "b", dir: "/r/b", description: "desc b" },
  ]);
  eq(out.includes("- a — /r/a/SKILL.md\n- b: desc b — /r/b/SKILL.md"), true);
});

test("renderVibeAgentTOML: escaping survives quotes, backslashes, and triple quotes", () => {
  const entry = { name: "x", description: 'd\\"q', persona: 'Ends with quote " and \\"\\"\\" triple' };
  const out = gen.renderVibeAgentTOML(entry, [{ name: "a", dir: "/r/a", description: null }]);
  eq(out.startsWith(`agent_type = "subagent"\ndescription = "d\\\\\\"q"`), true);
  eq(out.includes('quote \\" and \\"\\"\\" triple'), true);
  const body = out.slice(out.indexOf('instructions = """') + 18, out.lastIndexOf('"""'));
  eq(body.includes('"""'), false);   // no unescaped terminator inside the body
});

test("renderVibeAgentTOML: CRLF persona is normalized, no \\r in output", () => {
  const out = gen.renderVibeAgentTOML(
    { name: "x", description: "d", persona: "line1\r\nline2" }, []);
  eq(out.includes("\r"), false);
  eq(out.includes("line1\nline2"), true);
});
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `node scripts/test.mjs`
Expected: FAIL (`renderVibeAgentTOML is not a function`); existing tests PASS.

- [ ] **Step 3: Implement in `scripts/generate.mjs`**

Define `VIBE_MARKER` and `VIBE_BOILERPLATE` exactly:

```js
export const VIBE_MARKER = "You have no skill tool; if one is offered anyway, do not use it.";
export const VIBE_BOILERPLATE = [
  VIBE_MARKER,
  "Your skills are files. When a task matches one, read its SKILL.md with read_file and follow it.",
  "If a skill's instructions tell you to use or load another skill, read that skill's SKILL.md the same way and follow it.",
  "If a read comes back truncated, say so.",
].join("\n");
```

`renderVibeAgentTOML(entry, skills)`: normalize `entry.persona` (strip `\r` and other control characters except `\n`; tab → space) and escape it for a TOML multi-line basic string (`\` → `\\`, `"` → `\"`); escape `entry.description` for a TOML basic string the same way; emit `agent_type`, `description`, `disabled_tools = ["skill"]`, `instructions = """` + persona + blank line + `VIBE_BOILERPLATE` + blank line + one row per skill (`- <name>: <description> — <dir>/SKILL.md`, or `- <name> — <dir>/SKILL.md` when description is `null`), closing with `"""` and a trailing newline. Zero skills produce the header + persona + boilerplate with no rows (the writer only calls this for ≥1 skill, but the renderer must not crash on empty input).

- [ ] **Step 4: Run the full suite**

Run: `node scripts/test.mjs`
Expected: `all green`.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: render Vibe subagent TOML with clean-room instructions"
```

### Task 3: `writeVibeAgentFiles`

**Files:**
- Modify: `scripts/generate.mjs`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `renderVibeAgentTOML`, `discoverSkills`, `loadManifest` (existing).
- Produces: `export function writeVibeAgentFiles(root, manifest, skip = new Set()) -> { written: string[], removed: string[] }` — writes `agents-vibe/<name>.toml`; removes a stale TOML for a zero-skill entry; skips entries in `skip` (failed clones) entirely, leaving any pre-existing file untouched. Warnings/dropped stay the pi writer's responsibility (reported once); this function does not duplicate them.

- [ ] **Step 1: Write failing tests**

```js
test("writeVibeAgentFiles: writes, idempotent, removes zero-skill leftovers", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "zero", url: "https://github.com/x/y", description: "d", persona: "p" },
  ]}));
  skill(root, "skills/one/a");
  w(root, "agents-vibe/zero.toml", "stale");
  const m = gen.loadManifest(root);
  const r = gen.writeVibeAgentFiles(root, m);
  eq(r.written.join(","), "one");
  eq(r.removed.join(","), "zero");
  const first = fs.readFileSync(path.join(root, "agents-vibe/one.toml"), "utf8");
  gen.writeVibeAgentFiles(root, m);
  eq(fs.readFileSync(path.join(root, "agents-vibe/one.toml"), "utf8"), first);
  eq(fs.existsSync(path.join(root, "agents-vibe/zero.toml")), false);
  clean(root);
});

test("writeVibeAgentFiles: failed entries are skipped, file untouched", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "bad", url: "https://github.com/x/y", description: "d", persona: "p" }]}));
  w(root, "agents-vibe/bad.toml", "pre-existing");
  const r = gen.writeVibeAgentFiles(root, gen.loadManifest(root), new Set(["bad"]));
  eq(r.written.length, 0);
  eq(fs.readFileSync(path.join(root, "agents-vibe/bad.toml"), "utf8"), "pre-existing");
  clean(root);
});
```

- [ ] **Step 2: Run the suite to verify failure**

Run: `node scripts/test.mjs`
Expected: FAIL (`writeVibeAgentFiles is not a function`).

- [ ] **Step 3: Implement**

Mirror `writeAgentFiles` (`scripts/generate.mjs:150-169`): same loop shape, `agents-vibe` directory, `.toml` extension, `renderVibeAgentTOML(entry, found.skills)` for writing, `fs.existsSync` + `fs.rmSync` for the zero-skill stale case, `skip.has(entry.name)` continue.

- [ ] **Step 4: Run the full suite**

Run: `node scripts/test.mjs`
Expected: `all green`.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: write agents-vibe TOMLs with zero-skill and failure parity"
```

### Task 4: `mergeVibeConfig` — scan grammar and the `agent_paths` duty

**Files:**
- Modify: `scripts/generate.mjs`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `expandTilde`, `realPath`, `atomicWrite` (existing internal helpers).
- Produces: `export function mergeVibeConfig(configPath, repoRoot) -> { agentPaths: { changed: boolean, error?: string }, allowlist: { changed: boolean, error?: string } }`. Task 5 fills the `allowlist` duty (initially return `{ changed: false }`). `.bak` handling and EOL/BOM rules match `mergeSettings` discipline. Later tasks print `error` strings verbatim in the report.

- [ ] **Step 1: Write failing tests**

Write these tests with the existing `tmp()`/`w()`/`clean()` helpers, each creating `config.toml` inside a root and calling `gen.mergeVibeConfig(sp, root)`:

1. `mergeVibeConfig: missing file is created with agent_paths only` — result `agentPaths.changed === true`; file content is exactly `agent_paths = ["<root>/agents-vibe"]\n`; parent dirs created (config under a nested `VIBE_HOME`-style path); `.bak` absent.
2. `mergeVibeConfig: absent key inserted before the first table, below BOM` — fixture `"\uFEFF# top comment\n[tools.bash]\nallowlist = []\n"`; assert the key line is index 1 (after BOM-stripped first line), before `[tools.bash]`.
3. `mergeVibeConfig: absent key + no tables appends at EOF; missing trailing newline tolerated` — fixture `"active_model = \"x\""` (no newline); output contains `active_model = "x"\nagent_paths = ...`.
4. `mergeVibeConfig: absent key + indented and [[x]] headers still bound the region` — fixture with `"  [a.b]\nx = 1\n[[c]]\ny = 2\n"`; key inserted before the `  [a.b]` line.
5. `mergeVibeConfig: single-line array merged, idempotent, .bak written` — fixture `agent_paths = ["/other", '<root>/agents-vibe']` variants: no-space spelling `agent_paths=["/other"]`, literal-quoted `['/other']`, trailing comma `["/other",]`; all merge to include the entry exactly once; second run `changed === false`; `.bak` equals the original; user line content preserved otherwise.
6. `mergeVibeConfig: agent_paths under a sub-table is invisible, never edited` — fixture `"[foo]\nagent_paths = [\"/other\"]\n"`; result: top-level key inserted before `[foo]`; the `[foo]` line and its `agent_paths` line byte-identical afterwards.
7. `mergeVibeConfig: multi-line array, inline comment, non-array value, duplicate keys all safe-bail` — four fixtures; each: `changed === false`, `error` matches `/agent_paths/`, file bytes unchanged, no `.bak`, and the error string contains the literal text `add "<root>/agents-vibe" to agent_paths` (the manual remedy).
8. `mergeVibeConfig: any triple-quote string in the file forces safe-bail` — fixture containing `instructions = """\nagent_paths = ["/fake"]\n"""`; bytes unchanged, error present.
9. `mergeVibeConfig: CRLF file keeps CRLF on inserted lines` — fixture with `\r\n` endings; the inserted line ends `\r\n`.
10. `mergeVibeConfig: .bak replaced atomically, not written through a symlink` — mirror the pi test at `test.mjs:573`: symlink `config.toml.bak` → `victim.txt`; after a changed merge, `victim.txt` untouched and `.bak` is a regular file.

- [ ] **Step 2: Run the suite to verify failure**

Run: `node scripts/test.mjs`
Expected: FAIL (`mergeVibeConfig is not a function`).

- [ ] **Step 3: Implement**

Structure (all in `scripts/generate.mjs`, internal helpers may be non-exported):

- `readToml(configPath)` → `{ raw, hadBom, eol, lines }` or `null` when the file cannot be read as text. `eol` = `"\r\n"` if the first line ends with it, else `"\n"`.
- Scan: if `raw.includes('"""') || raw.includes("'''")` → bail both duties with errors. Region = lines before the first index matching `/^\s*\[/.`
- `agentPaths` duty: find `/^\s*agent_paths\s*=/` matches in the region only. Zero → insert `agent_paths = ["<absolute repoRoot>/agents-vibe"]` (absolute — never `~`) before the first header, skipping back over the header's contiguous `/^\s*#/` comment block; handle BOM (line 0 keeps its stripped content re-prefixed), missing trailing newline (add one before appending), EOL on new lines. One match → strict grammar `/^\s*agent_paths\s*=\s*\[(.*)\]\s*$/` on the raw line; parse elements (double- or single-quoted strings, comma+whitespace separated, optional trailing comma; anything else → bail); compare each `expandTilde`d element via `realPath` against the target (reuse the `mergeSettings` comparison pattern at `generate.mjs:249-251`); if present → `changed: false`, else re-render the line canonically (all elements double-quoted, entry appended) and rewrite the file. Two or more matches → bail (duplicate keys).
- Bail error copy, verbatim: `vibe config: agent_paths unmergeable; add "<entry>" to the agent_paths array in <configPath> manually`. Missing-file creation writes only the `agent_paths` key (Task 5 adds the allowlist table to the fresh-file branch).
- Write discipline: `.bak` via `atomicWrite` of the original bytes immediately before the first modifying write (no `.bak` on no-change/bail); final content via `atomicWrite`; `fs.mkdirSync(dirname, { recursive: true })` for the fresh-file case. Wrap all file I/O so a read-only config or unwritable `VIBE_HOME` returns `{ changed: false, error }` instead of throwing (the failure table's "never crash mid-flow" row).
- Return `{ agentPaths, allowlist: { changed: false } }` for now.

- [ ] **Step 4: Run the full suite**

Run: `node scripts/test.mjs`
Expected: `all green`.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: merge agent_paths into Vibe config with strict TOML scan envelope"
```

### Task 5: `mergeVibeConfig` — the `[tools.read_file]` allowlist duty

**Files:**
- Modify: `scripts/generate.mjs`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: Task 4's `mergeVibeConfig` skeleton, scan grammar, write discipline.
- Produces: the `allowlist` half of the return value: `{ changed: boolean, error?: string }`. The allowlist entry value is `path.join(repoRoot, "skills") + "/**"` (dedup by exact string equality — they are glob patterns, not paths).

- [ ] **Step 1: Write failing tests**

1. `mergeVibeConfig: missing file is created with agent_paths AND the allowlist table` — fresh-file content is exactly:
   ```
   agent_paths = ["<root>/agents-vibe"]

   [tools.read_file]
   allowlist = ["<root>/skills/**"]
   ```
2. `mergeVibeConfig: absent table appended at EOF` — fixture ending with an unrelated `[other]` table; the new table lands after everything; a blank line separates it.
3. `mergeVibeConfig: single-line allowlist merged, idempotent` — fixture `[tools.read_file]\nallowlist = ["/safe/**"]`; after merge the array contains both entries; second run `changed === false`; `.bak` written once.
4. `mergeVibeConfig: dotted variant table forces bail` — fixture `[tools.read_file.sub]` (header not exactly `[tools.read_file]`): file untouched, `error` mentions the manual remedy and includes the literal `<root>/skills/**` value to add.
5. `mergeVibeConfig: multi-line allowlist or inline comment bails with remedy` — bytes unchanged.
6. `mergeVibeConfig: table present with no allowlist key` — `allowlist` line inserted directly under the header; other keys in the table preserved.

- [ ] **Step 2: Run the suite to verify failure**

Run: `node scripts/test.mjs`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

Extend `mergeVibeConfig`: locate a header line matching `/^\s*\[tools\.read_file\]\s*$/` (exact; any dotted variant → bail). Absent → append at EOF (blank line + header + `allowlist = ["<root>/skills/**"]`), respecting EOL and trailing-newline rules; this append is always structurally valid TOML regardless of what precedes it. Present → within that table's section (lines until the next header), find `/^\s*allowlist\s*=/` with the same strict single-line grammar as Task 4; zero matches → insert the line directly under the header; one match → exact-string dedup and canonical re-render; anything else (multi-line, inline comment, non-array) → bail. Bail error copy, verbatim: `vibe config: [tools.read_file] allowlist unmergeable; add "<root>/skills/**" to the allowlist array in <configPath> manually`. Update the fresh-file branch from Task 4 to include the table.

- [ ] **Step 4: Run the full suite**

Run: `node scripts/test.mjs`
Expected: `all green`.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: ensure read_file allowlist auto-approves clone reads"
```

### Task 6: Prune covers `agents-vibe/`

**Files:**
- Modify: `scripts/generate.mjs` (`prune`, `generate.mjs:171-201`)
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `VIBE_MARKER` (Task 2).
- Produces: `prune(root, manifest)` return gains `vibeAgents: string[]` alongside `{ agents, clones }`. Marker rule: a `agents-vibe/<name>.toml` whose `<name>` left the manifest is removed only when its content contains `VIBE_MARKER`; otherwise it is a user file and survives.

- [ ] **Step 1: Write failing tests**

```js
test("prune: generated vibe TOMLs removed by marker, user files survive", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" }]}));
  const gen1 = gen.renderVibeAgentTOML({ name: "orphan", description: "d", persona: "p" },
    [{ name: "a", dir: "/r/a", description: null }]);
  w(root, "agents-vibe/orphan.toml", gen1);
  w(root, "agents-vibe/myown.toml", 'agent_type = "subagent"\ndescription = "mine"\n');
  const r = gen.prune(root, gen.loadManifest(root));
  eq(r.vibeAgents.join(","), "orphan");
  eq(fs.existsSync(path.join(root, "agents-vibe/orphan.toml")), false);
  eq(fs.existsSync(path.join(root, "agents-vibe/myown.toml")), true);
  clean(root);
});
```

- [ ] **Step 2: Run the suite to verify failure**

Run: `node scripts/test.mjs`
Expected: FAIL (`r.vibeAgents` undefined).

- [ ] **Step 3: Implement**

In `prune`: add an `agents-vibe` scan mirroring the `agents` scan — for each `*.toml` whose base name is not in the manifest, read the file and remove it only when the content includes `VIBE_MARKER`; push the name into `vibeAgents`.

- [ ] **Step 4: Run the full suite**

Run: `node scripts/test.mjs`
Expected: `all green`.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: prune agents-vibe by boilerplate marker"
```

### Task 7: `statusOf` VIBE column

**Files:**
- Modify: `scripts/generate.mjs` (`statusOf`, `printStatus`)
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `renderVibeAgentTOML` (Task 2), `discoverSkills`.
- Produces: `statusOf(root, manifest, opts = {})` where `opts.userAgentsDir` defaults to `~/.vibe/agents`; each row gains `vibe: "in-sync" | "stale" | "missing" | "—"`; return gains `warnings: string[]` (name-collision notes, exit-neutral). `exitCode` is 0 only when every row has `clone === "ok"`, `agent === "in-sync"`, and `vibe` is `"in-sync"` or `"—"`.

- [ ] **Step 1: Write failing tests**

1. `status: vibe column in-sync alongside pi` — extend the existing happy-path fixture (`test.mjs:279-296`): write `agents-vibe/one.toml` via `renderVibeAgentTOML`; row.vibe === `"in-sync"`; zero-skill entry with no TOML → `"—"`; exit 0.
2. `status: zero-skill leftover TOML is stale and fails exit` — the `zero` entry from the same fixture with a leftover `agents-vibe/zero.toml` → `vibe === "stale"`, exit 1, while pi agent stays `"in-sync"` (Review Focus #5).
3. `status: only-vibe-stale forces exit 1` — persona change fixture: `agents/one.md` current, `agents-vibe/one.toml` stale → `agent === "in-sync"`, `vibe === "stale"`, exit 1.
4. `status: name collision with user agents dir is a warning, not an exit` — pass `opts.userAgentsDir` pointing at a temp dir containing `one.toml`; `warnings.some(/one.*collision/)`; exit unaffected.

- [ ] **Step 2: Run the suite to verify failure**

Run: `node scripts/test.mjs`
Expected: FAIL on new tests.

- [ ] **Step 3: Implement**

In `statusOf`: for each entry, compute `vibe` — zero skills → `fs.existsSync(tomlPath) ? "stale" : "—"`; ≥1 skill → byte-compare `renderVibeAgentTOML(entry, found.skills)` against the file (`"in-sync"`/`"stale"`/`"missing"`, mirroring the pi logic at `generate.mjs:280-287`). Collect warnings for manifest names that also exist in `opts.userAgentsDir`. Extend `ok` per the interface rule. `printStatus` gains a VIBE column (headers padded to fit `in-sync`) and prints warnings below the table.

- [ ] **Step 4: Run the full suite**

Run: `node scripts/test.mjs`
Expected: `all green`.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs
git commit -m "feat: status tracks Vibe target with zero-skill parity"
```

### Task 8: Flow integration, CLI, README

**Files:**
- Modify: `scripts/generate.mjs` (`runFlow`, `runInstall`, `runUpdate`, CLI block at `generate.mjs:411-426`)
- Modify: `README.md`
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 3-7.
- Produces: `runInstall(root, settingsPath, vibeConfigPath)` and `runUpdate(root, settingsPath, vibeConfigPath)`; `DEFAULT_VIBE_CONFIG()` = `path.join(process.env.VIBE_HOME || path.join(os.homedir(), ".vibe"), "config.toml")`. CLI behavior unchanged: `install`, `update`, `status` take no new arguments.

- [ ] **Step 1: Write failing tests**

1. `install: writes both targets, wires both settings` — extend the existing install test (`test.mjs:339-357`, bareRemote fixture): after `gen.runInstall(root, sp, vp)`: `agents-vibe/a.toml` content equals `renderVibeAgentTOML(...)` for the discovered skills; `config.toml` at `vp` contains the `agent_paths` entry and the allowlist table; exit reflects clone failure as before.
2. `install: clone failure leaves pre-existing vibe TOML untouched` — pre-write `agents-vibe/b.toml = "pre-existing"` for the failing entry `b`; bytes unchanged after the run.
3. `install: vibe config bail is report-only` — `vp` holds a multi-line `agent_paths` array; run exits 0 (when no clone failures); report has exactly one `vibe config:` line matching `skipped` and containing the manual remedy.
4. `install: report mentions both targets and prints reminders` — report contains `a: cloned, 1 skills, agent written (pi, vibe)`, a `vibe config: agent_paths added` line, a `vibe config: allowlist added` line, and both reminder lines (verbatim below).
5. `update: deltas reported once` — extend the delta test (`test.mjs:372-385`): `a: +1 (two)` appears exactly once in the report even though both targets were written.

- [ ] **Step 2: Run the suite to verify failure**

Run: `node scripts/test.mjs`
Expected: FAIL on new tests.

- [ ] **Step 3: Implement `runFlow` changes**

In `runFlow(root, settingsPath, vibeConfigPath, mode)`: after `writeAgentFiles`, call `writeVibeAgentFiles(root, manifest, failed)`; run `mergeVibeConfig(vibeConfigPath, root)` after the writers; append to the report — `vibe config: agent_paths added <entry>` / `already configured` / `skipped (<error>)`, and the same three shapes for `allowlist`; per-entry line becomes `<name>: <state>, <n> skills, agent written (pi, vibe)` / `(pi)` / `no agent` based on the two `written` sets; prune report adds `pruned <name> (vibe agent)`; append two verbatim reminder lines at the end:
- `reminder: run /reload (or restart Vibe) to pick up new agents`
- `reminder: enabled_agents / disabled_agents config filters override agent discovery`
`runInstall`/`runUpdate` thread `vibeConfigPath ?? DEFAULT_VIBE_CONFIG()`. `status` CLI call passes no opts (defaults apply).

- [ ] **Step 4: Run the full suite**

Run: `node scripts/test.mjs`
Expected: `all green`.

- [ ] **Step 5: Update README**

In `README.md`: extend "How it works" with a Vibe paragraph (one agent per repo into `agents-vibe/`, `disabled_tools = ["skill"]` + skill table = the clean-room, `agent_paths` + `[tools.read_file]` allowlist wiring into `~/.vibe/config.toml`, `VIBE_HOME` honored, `/reload` needed); extend "Uninstall" with removing the two config entries; leave "Quickstart" and "Tests" unchanged.

- [ ] **Step 6: Verify against the real repo, read-only**

Run: `./install.sh status`
Expected: exit 1 with pi columns as before (`in-sync` where current) and the VIBE column `missing` for every skill-bearing entry — correct pre-generation state; no TOMLs exist yet, and this command writes nothing. Generating the real `agents-vibe/*.toml` requires `./install.sh install|update`, which also merges into the live `~/.pi/agent/settings.json` and `~/.vibe/config.toml` — that is the user-driven validation step below the plan, not an executor action. Do not run it here. Run `node scripts/test.mjs` once more: `all green`.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate.mjs scripts/test.mjs README.md
git commit -m "feat: drive Vibe target from install/update; document it"
```

---

## Out of plan scope

The spec's "Assumptions to validate on first run" checklist (agent discovery, `disabled_tools` enforcement, permission-wall behavior, advertisement bleed, routing fidelity, TOML parser acceptance) runs against a live Vibe install after implementation, driven by the user — the offline suite cannot exercise it. Running `./install.sh install` against the real `~/.vibe/config.toml` is likewise the user's call (it mutates live config; the `.bak` discipline applies).
