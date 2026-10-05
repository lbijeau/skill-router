#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as gen from "./generate.mjs";

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function eq(a, e, msg) { msg === undefined ? assert.strictEqual(a, e) : assert.strictEqual(a, e, msg); }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "sr-")); }
function w(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function clean(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

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
    { name: "a", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "a", url: "https://github.com/x/y2", description: "d", persona: "p" },
  ]}));
  assert.throws(() => gen.loadManifest(root), /duplicate name: a/);
  clean(root);
});

test("loadManifest rejects invalid names", () => {
  for (const bad of ["Bad_Name", "-x", "x-", "a--b", "a b"]) {
    const root = tmp();
    w(root, "repos.json", JSON.stringify({ repos: [
      { name: bad, url: "https://github.com/x/y", description: "d", persona: "p" }]}));
    assert.throws(() => gen.loadManifest(root), /invalid name/);
    clean(root);
  }
});

test("loadManifest rejects missing required fields", () => {
  for (const missing of ["url", "description", "persona"]) {
    const root = tmp();
    const entry = { name: "a", url: "https://github.com/x/y", description: "d", persona: "p" };
    delete entry[missing];
    w(root, "repos.json", JSON.stringify({ repos: [entry] }));
    assert.throws(() => gen.loadManifest(root), new RegExp(`a: missing ${missing}`));
    clean(root);
  }
});

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

function skill(root, rel, name) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"),
    `---\nname: ${name ?? path.basename(rel)}\ndescription: test skill\n---\n# body\n`);
}

const E = (over = {}) => ({ name: "x", url: "https://github.com/x/y", description: "d", persona: "p", ...over });

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
  eq(dd.skills.map(s => s.name).sort().join(","), "c,one");
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

test("renderAgentFile: exact bytes, YAML-escaped description", () => {
  const entry = { name: "ponytail", url: "https://github.com/x/y",
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
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "zero", url: "https://github.com/x/y", description: "d", persona: "p" },
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
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" }]}));
  w(root, "agents/one.md", "keep");
  w(root, "agents/orphan.md", "---\nname: orphan\nskillPath: ../skills/orphan\n---\nx\n");
  w(root, "skills/one/keep.txt", "keep");
  w(root, "skills/orphan/junk.txt", "drop");
  const r = gen.prune(root, gen.loadManifest(root));
  eq(r.agents.join(","), "orphan");
  eq(r.clones.join(","), "orphan");
  eq(fs.existsSync(path.join(root, "agents/one.md")), true);
  eq(fs.existsSync(path.join(root, "skills/orphan")), false);
  clean(root);
});

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
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "zero", url: "https://github.com/x/y", description: "d", persona: "p" },
  ]};
  w(root, "repos.json", JSON.stringify(manifest));
  skill(root, "skills/one/a");
  gitRepo(path.join(root, "skills/one"));
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
    { name: "stale", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "nofile", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "dirty", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "fake", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "gone", url: "https://github.com/x/y", description: "d", persona: "p" },
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
  w(root, "agents/orphan.md", "---\nname: orphan\nskillPath: ../skills/orphan\n---\nx\n");
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

test("discovery: SKILL.md match is case-exact (portable to Linux)", () => {
  const root = tmp();
  const lower = path.join(root, "lower"); fs.mkdirSync(lower, { recursive: true });
  fs.writeFileSync(path.join(lower, "skill.md"), "---\nname: lower\ndescription: d\n---\nx\n");
  skill(root, "exact/x");
  const r = gen.discoverSkills(root, E());
  eq(r.skills.map(s => s.name).join(","), "x");
  clean(root);
});

test("discovery: names outside the agentskills charset are skipped with a warning", () => {
  const root = tmp();
  skill(root, "skills/dash", "-bad");
  skill(root, "skills/alias", "*alias");
  skill(root, "skills/upper", "BadName");
  skill(root, "skills/ok");
  const r = gen.discoverSkills(root, E());
  eq(r.skills.map(s => s.name).join(","), "ok");
  eq(r.warnings.filter(x => /unexpressible/.test(x)).length, 3);
  clean(root);
});

test("renderAgentFile: multi-line description is escaped into one YAML line", () => {
  const entry = { name: "x", description: "line1\nline2", persona: "p" };
  const out = gen.renderAgentFile(entry, ["a"]);
  eq(out.split("\n")[2], 'description: "line1\\nline2"');
});

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
  const entry = { name: "x", description: 'd\\"q', persona: 'Ends with quote " and """ triple' };
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

test("install: clone failure leaves pre-existing agent file untouched", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" },
    { name: "b", url: "file://" + path.join(root, "nope.git"), description: "d", persona: "p" },
  ]}));
  w(root, "agents/b.md", "previously generated agent");
  const r = gen.runInstall(root, sp);
  eq(r.exitCode, 1);
  eq(fs.readFileSync(path.join(root, "agents/b.md"), "utf8"), "previously generated agent");
  clean(root);
});

test("discovery: unclosed frontmatter is skipped with a warning", () => {
  const root = tmp();
  w(root, "hijack/SKILL.md", "---\ndescription: d\n\n# Usage\n\nname: hijacked-name\n");
  const r = gen.discoverSkills(root, E());
  eq(r.skills.length, 0);
  eq(r.warnings.some(x => /hijack/.test(x) && /closing/.test(x)), true);
  clean(root);
});

test("mergeSettings: symlinked existing entry is recognized as equivalent", () => {
  const root = tmp();
  const real = path.join(root, "real");
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, path.join(root, "link"));
  const sp = path.join(root, "settings.json");
  w(root, "settings.json", JSON.stringify(
    { subagents: { agentScanDirs: [path.join(root, "link", "agents")] } }));
  const r = gen.mergeSettings(sp, real);
  eq(r.changed, false);
  clean(root);
});

test("loadManifest rejects pathExclude that is not an array of strings", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: "https://github.com/x/y", description: "d", persona: "p", pathExclude: "skills/x/**" }]}));
  assert.throws(() => gen.loadManifest(root), /pathExclude must be an array/);
  clean(root);
});

test("loadManifest rejects skillSource escaping the clone", () => {
  for (const bad of ["../other", "..", "/abs/skills"]) {
    const root = tmp();
    w(root, "repos.json", JSON.stringify({ repos: [
      { name: "a", url: "https://github.com/x/y", description: "d", persona: "p", skillSource: bad }]}));
    assert.throws(() => gen.loadManifest(root), /skillSource/);
    clean(root);
  }
});

test("mergeSettings: settings file containing null is backed up before write", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  w(root, "settings.json", "null");
  const r = gen.mergeSettings(sp, root);
  eq(r.changed, true);
  eq(fs.readFileSync(sp + ".bak", "utf8"), "null");
  eq(JSON.parse(fs.readFileSync(sp, "utf8")).subagents.agentScanDirs[0], path.join(root, "agents"));
  clean(root);
});

test("install: unparseable settings reports only the skipped line", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" }]}));
  w(root, "settings.json", "{ not json");
  const r = gen.runInstall(root, sp);
  eq(r.exitCode, 0);
  eq(r.report.filter(l => l.startsWith("settings:")).length, 1);
  eq(/skipped/.test(r.report.find(l => l.startsWith("settings:"))), true);
  clean(root);
});

test("loadManifest rejects injection-prone or unsupported urls", () => {
  for (const bad of [
    "--upload-pack=touch /tmp/x",
    "ssh://git@github.com/o/r",
    "/local/path",
    "http://github.com/o/r",
  ]) {
    const root = tmp();
    w(root, "repos.json", JSON.stringify({ repos: [
      { name: "a", url: bad, description: "d", persona: "p" }]}));
    assert.throws(() => gen.loadManifest(root), /url must be/i);
    clean(root);
  }
});

test("loadManifest accepts https GitHub and file:// mirror urls", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: "https://github.com/o/r", description: "d", persona: "p" },
    { name: "b", url: "file:///tmp/mirror.git", description: "d", persona: "p" },
  ]}));
  eq(gen.loadManifest(root).repos.length, 2);
  clean(root);
});

test("loadManifest rejects skillSource escaping via backslash (cross-platform)", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: "https://github.com/x/y", description: "d", persona: "p", skillSource: "..\\evil" }]}));
  assert.throws(() => gen.loadManifest(root), /skillSource/);
  clean(root);
});

test("update: changed manifest url re-clones from the new remote", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const ra = bareRemote(tmp()); ra.add(path.join("skills", "one"), "one");
  const rb = bareRemote(tmp()); rb.add(path.join("skills", "two"), "two");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: ra.url, description: "d", persona: "p" }]}));
  eq(gen.runInstall(root, sp).exitCode, 0);
  eq(fs.readFileSync(path.join(root, "agents/a.md"), "utf8"),
     gen.renderAgentFile({ name: "a", description: "d", persona: "p" }, ["one"]));
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: rb.url, description: "d", persona: "p" }]}));
  const r = gen.runUpdate(root, sp);
  eq(r.exitCode, 0);
  eq(r.report.some(l => /url changed/.test(l)), true);
  eq(fs.readFileSync(path.join(root, "agents/a.md"), "utf8"),
     gen.renderAgentFile({ name: "a", description: "d", persona: "p" }, ["two"]));
  clean(root);
});

test("mergeSettings: .bak is replaced atomically, not written through a symlink", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  w(root, "settings.json", JSON.stringify({ a: 1 }));
  w(root, "victim.txt", "do not touch");
  fs.symlinkSync(path.join(root, "victim.txt"), sp + ".bak");
  const r = gen.mergeSettings(sp, root);
  eq(r.changed, true);
  eq(fs.readFileSync(path.join(root, "victim.txt"), "utf8"), "do not touch");
  eq(fs.lstatSync(sp + ".bak").isSymbolicLink(), false);
  eq(JSON.parse(fs.readFileSync(sp + ".bak", "utf8")).a, 1);
  clean(root);
});

test("prune: only generated agent files are pruned, user files survive", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" }]}));
  w(root, "agents/orphan.md", "---\nname: orphan\nskillPath: ../skills/orphan\n---\nx\n");
  w(root, "agents/myown.md", "---\nname: myown\nskillPath: ~/.pi/other/agents\n---\ny\n");
  w(root, "skills/orphan/junk.txt", "clone orphan");
  const r = gen.prune(root, gen.loadManifest(root));
  eq(r.agents.join(","), "orphan");
  eq(fs.existsSync(path.join(root, "agents/myown.md")), true);
  eq(fs.existsSync(path.join(root, "agents/orphan.md")), false);
  clean(root);
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
