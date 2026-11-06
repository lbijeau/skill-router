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

test("tildePath: paths under home become ~-relative, others unchanged", () => {
  const home = "/fake/home";
  eq(gen.tildePath("/fake/home/repos/x/skills/a/SKILL.md", home), "~/repos/x/skills/a/SKILL.md");
  eq(gen.tildePath("/fake/home", home), "~");
  eq(gen.tildePath("/fake/other/x", home), "/fake/other/x");
  eq(gen.tildePath("/fake/homes/x", home), "/fake/homes/x");   // shared prefix, not under
});

test("renderVibeAgentTOML: skill rows under home use ~-anchored paths", () => {
  const home = "/fake/home";
  const out = gen.renderVibeAgentTOML({ name: "x", description: "d", persona: "p" },
    [{ name: "a", dir: "/fake/home/repositories/skill-router/skills/x/a", description: "desc" }],
    { home });
  eq(out.includes("- a: desc — ~/repositories/skill-router/skills/x/a/SKILL.md"), true);
  eq(out.includes("/fake/home"), false);   // no home path leaks into the file
});

test("renderVibeAgentTOML: rows outside home stay absolute", () => {
  const home = "/fake/home";
  const out = gen.renderVibeAgentTOML({ name: "x", description: "d", persona: "p" },
    [{ name: "a", dir: "/opt/elsewhere/skills/x/a", description: null }], { home });
  eq(out.includes("- a — /opt/elsewhere/skills/x/a/SKILL.md"), true);
});

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
  const found = gen.discoverSkills(path.join(root, "skills/one"), manifest.repos[0]);
  w(root, "agents-vibe/one.toml", gen.renderVibeAgentTOML(manifest.repos[0], found.skills));
  gitRepo(path.join(root, "skills/zero"));           // clone ok, no skills
  gen.writeSkillCatalog(root, manifest);
  gen.writeRouterAgent(root);
  const r = gen.statusOf(root, manifest);
  eq(r.catalog, "in-sync");
  eq(r.router, "in-sync");
  eq(r.rows.length, 2);
  eq(r.rows.find(x => x.name === "zero").agent, "in-sync");
  eq(r.rows.find(x => x.name === "one").agent, "in-sync");
  eq(r.rows.find(x => x.name === "one").vibe, "in-sync");
  eq(r.rows.find(x => x.name === "zero").vibe, "—");
  eq(r.exitCode, 0);
  clean(root);
});

test("status: zero-skill leftover TOML is stale and fails exit", () => {
  const root = tmp();
  const manifest = { repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "zero", url: "https://github.com/x/y", description: "d", persona: "p" },
  ]};
  w(root, "repos.json", JSON.stringify(manifest));
  skill(root, "skills/one/a");
  gitRepo(path.join(root, "skills/one"));
  w(root, "agents/one.md", gen.renderAgentFile(manifest.repos[0], ["a"]));
  const found = gen.discoverSkills(path.join(root, "skills/one"), manifest.repos[0]);
  w(root, "agents-vibe/one.toml", gen.renderVibeAgentTOML(manifest.repos[0], found.skills));
  gitRepo(path.join(root, "skills/zero"));
  gen.writeSkillCatalog(root, manifest);
  w(root, "agents-vibe/zero.toml", "leftover");
  const r = gen.statusOf(root, manifest);
  eq(r.rows.find(x => x.name === "zero").vibe, "stale");
  eq(r.rows.find(x => x.name === "one").agent, "in-sync");
  eq(r.exitCode, 1);
  clean(root);
});

test("status: only-vibe-stale forces exit 1", () => {
  const root = tmp();
  const manifest = { repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" }]};
  w(root, "repos.json", JSON.stringify(manifest));
  skill(root, "skills/one/a");
  gitRepo(path.join(root, "skills/one"));
  w(root, "agents/one.md", gen.renderAgentFile(manifest.repos[0], ["a"]));
  w(root, "agents-vibe/one.toml", "tampered");
  const r = gen.statusOf(root, manifest);
  eq(r.rows[0].agent, "in-sync");
  eq(r.rows[0].vibe, "stale");
  eq(r.exitCode, 1);
  clean(root);
});

test("status: name collision with user agents dir is a warning, not an exit", () => {
  const root = tmp(); const ua = tmp();
  const manifest = { repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" }]};
  w(root, "repos.json", JSON.stringify(manifest));
  skill(root, "skills/one/a");
  gitRepo(path.join(root, "skills/one"));
  w(root, "agents/one.md", gen.renderAgentFile(manifest.repos[0], ["a"]));
  const found = gen.discoverSkills(path.join(root, "skills/one"), manifest.repos[0]);
  w(root, "agents-vibe/one.toml", gen.renderVibeAgentTOML(manifest.repos[0], found.skills));
  w(ua, "one.toml", "user agent");
  gen.writeSkillCatalog(root, manifest);
  gen.writeRouterAgent(root);
  const r = gen.statusOf(root, manifest, { userAgentsDir: ua });
  eq(r.warnings.some(x => /one.*collision/.test(x)), true);
  eq(r.exitCode, 0);
  clean(root); clean(ua);
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
  const r = gen.runInstall(root, sp, path.join(root, "config.toml"));
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
  const r = gen.runInstall(root, path.join(root, "settings.json"), path.join(root, "config.toml"));
  eq(r.exitCode, 0);
  eq(fs.existsSync(path.join(root, "skills/a/.git")), true);
  eq(fs.existsSync(path.join(root, "skills/a/junk.txt")), false);
  clean(root);
});

test("update: pull --ff-only picks up new skills and reports deltas", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const vp = path.join(root, "config.toml");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" }]}));
  eq(gen.runInstall(root, sp, vp).exitCode, 0);
  remote.add(path.join("skills", "two"), "two");
  const r = gen.runUpdate(root, sp, vp);
  eq(r.exitCode, 0);
  eq(r.report.filter(l => /a: \+1 \(two\)/.test(l)).length, 1);
  eq(fs.readFileSync(path.join(root, "agents/a.md"), "utf8"),
     gen.renderAgentFile({ name: "a", description: "d", persona: "p" }, ["one", "two"]));
  clean(root);
});

test("update: non-ff remote is warned and left as-is, exit non-zero", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" }]}));
  eq(gen.runInstall(root, sp, path.join(root, "config.toml")).exitCode, 0);
  // rewrite remote history: amend + force push makes local pull non-ff
  spawnSync("git", ["-C", path.join(root, "work"), "commit", "--amend", "-q", "-m", "rewritten"]);
  spawnSync("git", ["-C", path.join(root, "work"), "push", "-q", "-f", "origin", "HEAD"]);
  const r = gen.runUpdate(root, sp, path.join(root, "config.toml"));
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
  gen.runInstall(root, path.join(root, "settings.json"), path.join(root, "config.toml"));
  w(root, "skills/a/local-change.txt", "x");
  const r = gen.runInstall(root, path.join(root, "settings.json"), path.join(root, "config.toml"));
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
  const r = gen.runInstall(root, sp, path.join(root, "config.toml"));
  eq(r.exitCode, 1);
  eq(fs.readFileSync(path.join(root, "agents/b.md"), "utf8"), "previously generated agent");
  clean(root);
});

test("install: writes both targets, wires both settings", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const vp = path.join(root, "config.toml");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" },
    { name: "b", url: "file://" + path.join(root, "nope.git"), description: "d", persona: "p" },
  ]}));
  const r = gen.runInstall(root, sp, vp);
  eq(r.exitCode, 1);                                    // entry b failed
  const found = gen.discoverSkills(path.join(root, "skills/a"), { name: "a", description: "d", persona: "p" });
  eq(fs.readFileSync(path.join(root, "agents-vibe/a.toml"), "utf8"),
    gen.renderVibeAgentTOML({ name: "a", description: "d", persona: "p" }, found.skills));
  const cfg = fs.readFileSync(vp, "utf8");
  eq(cfg.includes(`agent_paths = ["${path.join(root, "agents-vibe")}"]`), true);
  eq(cfg.includes(`allowlist = ["${path.join(root, "skills")}/*"`), true);
  eq(JSON.parse(fs.readFileSync(sp, "utf8")).subagents.agentScanDirs[0], path.join(root, "agents"));
  clean(root);
});

test("install: clone failure leaves pre-existing vibe TOML untouched", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" },
    { name: "b", url: "file://" + path.join(root, "nope.git"), description: "d", persona: "p" },
  ]}));
  w(root, "agents-vibe/b.toml", "pre-existing");
  const r = gen.runInstall(root, sp, path.join(root, "config.toml"));
  eq(r.exitCode, 1);
  eq(fs.readFileSync(path.join(root, "agents-vibe/b.toml"), "utf8"), "pre-existing");
  clean(root);
});

test("install: vibe config bail is report-only", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const vp = path.join(root, "config.toml");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" }]}));
  w(root, "config.toml", 'agent_paths = [\n  "/other",\n]\n');
  const r = gen.runInstall(root, sp, vp);
  eq(r.exitCode, 0);
  const skipped = r.report.filter(l => /vibe config: agent_paths skipped/.test(l));
  eq(skipped.length, 1);
  eq(/add "/.test(skipped[0]), true);
  clean(root);
});

test("install: report mentions both targets and prints reminders", () => {
  const root = tmp(); const sp = path.join(root, "settings.json");
  const vp = path.join(root, "config.toml");
  const remote = bareRemote(root); remote.add(path.join("skills", "one"), "one");
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: remote.url, description: "d", persona: "p" }]}));
  const r = gen.runInstall(root, sp, vp);
  eq(r.exitCode, 0);
  eq(r.report.some(l => /a: cloned, 1 skills, agent written \(pi, vibe\)/.test(l)), true);
  eq(r.report.some(l => /vibe config: agent_paths added/.test(l)), true);
  eq(r.report.some(l => /vibe config: allowlist added/.test(l)), true);
  eq(r.report.includes("reminder: run /reload (or restart Vibe) to pick up new agents"), true);
  eq(r.report.includes("reminder: enabled_agents / disabled_agents config filters override agent discovery"), true);
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
  const r = gen.runInstall(root, sp, path.join(root, "config.toml"));
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
  eq(gen.runInstall(root, sp, path.join(root, "config.toml")).exitCode, 0);
  eq(fs.readFileSync(path.join(root, "agents/a.md"), "utf8"),
     gen.renderAgentFile({ name: "a", description: "d", persona: "p" }, ["one"]));
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: rb.url, description: "d", persona: "p" }]}));
  const r = gen.runUpdate(root, sp, path.join(root, "config.toml"));
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

// The [tools.read_file] allowlist entries the generator ensures: Vibe matches
// absolute allowlist patterns with component-strict pathlib rules, so a single
// `**` matches nothing — the generator emits one pattern per depth, 1..8.
const allowPatterns = (root) =>
  Array.from({ length: 8 }, (_, i) => `${root}/skills${"/*".repeat(i + 1)}`);
const allowLine = (root, extra = []) =>
  `allowlist = [${[...extra, ...allowPatterns(root)].map(p => `"${p}"`).join(", ")}]`;

test("mergeVibeConfig: missing file is created with agent_paths and the allowlist table", () => {
  const root = tmp();
  const sp = path.join(root, "nested", "dir", "config.toml");
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.agentPaths.changed, true);
  eq(r.allowlist.changed, true);
  eq(fs.readFileSync(sp, "utf8"),
    `agent_paths = ["${root}/agents-vibe"]\n\n[tools.read_file]\n${allowLine(root)}\n`);
  eq(fs.existsSync(sp + ".bak"), false);
  clean(root);
});

test("mergeVibeConfig: absent key inserted before the first table, below BOM", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  w(root, "config.toml", "\uFEFF# top comment\n[tools.bash]\nallowlist = []\n");
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.agentPaths.changed, true);
  const lines = fs.readFileSync(sp, "utf8").replace(/^\uFEFF/, "").split("\n");
  eq(lines[0], `agent_paths = ["${root}/agents-vibe"]`);
  eq(lines[1], "# top comment");
  eq(lines[2], "[tools.bash]");
  clean(root);
});

test("mergeVibeConfig: absent key + no tables appends at EOF; missing trailing newline tolerated", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  w(root, "config.toml", 'active_model = "x"');
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.agentPaths.changed, true);
  eq(fs.readFileSync(sp, "utf8"),
    `active_model = "x"\nagent_paths = ["${root}/agents-vibe"]\n\n[tools.read_file]\n${allowLine(root)}\n`);
  clean(root);
});

test("mergeVibeConfig: absent key + indented and [[x]] headers still bound the region", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  w(root, "config.toml", "  [a.b]\nx = 1\n[[c]]\ny = 2\n");
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.agentPaths.changed, true);
  const lines = fs.readFileSync(sp, "utf8").split("\n");
  eq(lines[0], `agent_paths = ["${root}/agents-vibe"]`);
  eq(lines[1], "  [a.b]");
  clean(root);
});

test("mergeVibeConfig: single-line array merged, idempotent, .bak written", () => {
  for (const line of [
    'agent_paths = ["/other"]',
    'agent_paths=["/other"]',
    "agent_paths = ['/other']",
    'agent_paths = ["/other",]',
  ]) {
    const root = tmp(); const sp = path.join(root, "config.toml");
    const before = `${line}\n`;
    w(root, "config.toml", before);
    const r1 = gen.mergeVibeConfig(sp, root);
    eq(r1.agentPaths.changed, true, line);
    const after = `agent_paths = ["/other", "${root}/agents-vibe"]\n\n[tools.read_file]\n${allowLine(root)}\n`;
    eq(fs.readFileSync(sp, "utf8"), after, line);
    eq(fs.readFileSync(sp + ".bak", "utf8"), before, line);
    const r2 = gen.mergeVibeConfig(sp, root);
    eq(r2.agentPaths.changed, false, line);
    eq(fs.readFileSync(sp, "utf8"), after, line);
    clean(root);
  }
});

test("mergeVibeConfig: agent_paths under a sub-table is invisible, never edited", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  w(root, "config.toml", '[foo]\nagent_paths = ["/other"]\n');
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.agentPaths.changed, true);
  eq(fs.readFileSync(sp, "utf8"),
    `agent_paths = ["${root}/agents-vibe"]\n[foo]\nagent_paths = ["/other"]\n\n[tools.read_file]\n${allowLine(root)}\n`);
  clean(root);
});

test("mergeVibeConfig: multi-line array, inline comment, non-array value, duplicate keys all safe-bail", () => {
  const cases = [
    'agent_paths = [\n  "/other",\n]\n',
    'agent_paths = ["/other"] # mine\n',
    'agent_paths = "/other"\n',
    'agent_paths = ["/a"]\nagent_paths = ["/b"]\n',
  ];
  for (const head of cases) {
    const root = tmp(); const sp = path.join(root, "config.toml");
    // allowlist duty pre-satisfied so the fixture pins the agent_paths bail alone
    const before = `${head}\n[tools.read_file]\n${allowLine(root)}\n`;
    w(root, "config.toml", before);
    const r = gen.mergeVibeConfig(sp, root);
    eq(r.agentPaths.changed, false, head);
    eq(fs.readFileSync(sp, "utf8"), before);
    eq(fs.existsSync(sp + ".bak"), false, head);
    eq(r.agentPaths.error.includes(`add "${root}/agents-vibe" to the agent_paths`), true, head);
    clean(root);
  }
});

test("mergeVibeConfig: any triple-quote string in the file forces safe-bail", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  const before = 'instructions = """\nagent_paths = ["/fake"]\n"""\n';
  w(root, "config.toml", before);
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.agentPaths.changed, false);
  eq(fs.readFileSync(sp, "utf8"), before);
  eq(/unmergeable/.test(r.agentPaths.error), true);
  clean(root);
});

test("mergeVibeConfig: CRLF file keeps CRLF on inserted lines", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  w(root, "config.toml", "[tools.bash]\r\nallowlist = []\r\n");
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.agentPaths.changed, true);
  eq(fs.readFileSync(sp, "utf8"),
    `agent_paths = ["${root}/agents-vibe"]\r\n[tools.bash]\r\nallowlist = []\r\n\r\n[tools.read_file]\r\n${allowLine(root)}\r\n`);
  clean(root);
});

test("mergeVibeConfig: .bak replaced atomically, not written through a symlink", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  w(root, "config.toml", 'active_model = "x"\n');
  w(root, "victim.txt", "do not touch");
  fs.symlinkSync(path.join(root, "victim.txt"), sp + ".bak");
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.agentPaths.changed, true);
  eq(fs.readFileSync(path.join(root, "victim.txt"), "utf8"), "do not touch");
  eq(fs.lstatSync(sp + ".bak").isSymbolicLink(), false);
  eq(fs.readFileSync(sp + ".bak", "utf8"), 'active_model = "x"\n');
  clean(root);
});

test("mergeVibeConfig: absent allowlist table appended at EOF", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  w(root, "config.toml", 'agent_paths = ["/other"]\n[other]\nx = 1\n');
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.allowlist.changed, true);
  eq(r.agentPaths.changed, true);
  eq(fs.readFileSync(sp, "utf8"),
    `agent_paths = ["/other", "${root}/agents-vibe"]\n[other]\nx = 1\n\n[tools.read_file]\n${allowLine(root)}\n`);
  clean(root);
});

test("mergeVibeConfig: single-line allowlist merged, idempotent, .bak written once", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  const before = '[tools.read_file]\nallowlist = ["/safe/**"]\n';
  w(root, "config.toml", before);
  const r1 = gen.mergeVibeConfig(sp, root);
  eq(r1.allowlist.changed, true);
  eq(r1.agentPaths.changed, true);
  const after = `agent_paths = ["${root}/agents-vibe"]\n[tools.read_file]\n${allowLine(root, ["/safe/**"])}\n`;
  eq(fs.readFileSync(sp, "utf8"), after);
  eq(fs.readFileSync(sp + ".bak", "utf8"), before);
  const r2 = gen.mergeVibeConfig(sp, root);
  eq(r2.allowlist.changed, false);
  eq(r2.agentPaths.changed, false);
  eq(fs.readFileSync(sp, "utf8"), after);
  clean(root);
});

test("mergeVibeConfig: dotted variant table forces bail with remedy", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  const before = `agent_paths = ["${root}/agents-vibe"]\n[tools.read_file.sub]\nx = 1\n`;
  w(root, "config.toml", before);
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.allowlist.changed, false);
  eq(r.agentPaths.changed, false);
  eq(r.allowlist.error.includes(`add the depth patterns "${root}/skills/*"`), true);
  eq(fs.readFileSync(sp, "utf8"), before);
  clean(root);
});

test("mergeVibeConfig: multi-line allowlist or inline comment bails with remedy", () => {
  for (const tail of [
    '[tools.read_file]\nallowlist = [\n  "/safe/**",\n]\n',
    '[tools.read_file]\nallowlist = ["/safe/**"] # mine\n',
  ]) {
    const root = tmp(); const sp = path.join(root, "config.toml");
    const before = `agent_paths = ["${root}/agents-vibe"]\n${tail}`;
    w(root, "config.toml", before);
    const r = gen.mergeVibeConfig(sp, root);
    eq(r.allowlist.changed, false, tail);
    eq(r.allowlist.error.includes(`add the depth patterns "${root}/skills/*"`), true, tail);
    eq(fs.readFileSync(sp, "utf8"), before);
    eq(fs.existsSync(sp + ".bak"), false, tail);
    clean(root);
  }
});

test("mergeVibeConfig: table present with no allowlist key inserts under header, other keys preserved", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  const before = `agent_paths = ["${root}/agents-vibe"]\n[tools.read_file]\npermission = "ask"\n`;
  w(root, "config.toml", before);
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.allowlist.changed, true);
  eq(r.agentPaths.changed, false);
  eq(fs.readFileSync(sp, "utf8"),
    `agent_paths = ["${root}/agents-vibe"]\n[tools.read_file]\n${allowLine(root)}\npermission = "ask"\n`);
  clean(root);
});

test("mergeVibeConfig: unrecognized [tools.read_file] forms never duplicate the table", () => {
  for (const tail of [
    "[[tools.read_file]]\n",
    "[tools.read_file.sub]\n",
    'tools.read_file.allowlist = ["/x/**"]\n',
    '[tools]\nread_file.allowlist = ["/x/**"]\n',
    'tools = { read_file = { allowlist = ["/x/**"] } }\n',
  ]) {
    const root = tmp(); const sp = path.join(root, "config.toml");
    const before = `agent_paths = ["${root}/agents-vibe"]\n${tail}`;
    w(root, "config.toml", before);
    const r = gen.mergeVibeConfig(sp, root);
    eq(r.allowlist.changed, false, tail);
    eq(r.allowlist.error.includes(`add the depth patterns "${root}/skills/*"`), true, tail);
    eq(fs.readFileSync(sp, "utf8"), before);
    eq(fs.existsSync(sp + ".bak"), false, tail);
    clean(root);
  }
});

test("mergeVibeConfig: recognized [tools.read_file] header variants merge without duplication", () => {
  for (const header of [
    "[ tools.read_file ]\n",
    '[tools."read_file"]\n',
    "[tools.read_file] # overrides\n",
  ]) {
    const root = tmp(); const sp = path.join(root, "config.toml");
    const before = `agent_paths = ["${root}/agents-vibe"]\n${header}`;
    w(root, "config.toml", before);
    const r = gen.mergeVibeConfig(sp, root);
    eq(r.agentPaths.changed, false, header);
    eq(r.allowlist.changed, true, header);
    eq(fs.readFileSync(sp, "utf8"), `${before}${allowLine(root)}\n`, header);
    clean(root);
  }
});

test("mergeVibeConfig: populated multi-line array with bracket-initial continuation is not a header", () => {
  const root = tmp(); const sp = path.join(root, "config.toml");
  const before = 'theme = ["dark",\n  ["light"]]\n';
  w(root, "config.toml", before);
  const r = gen.mergeVibeConfig(sp, root);
  eq(r.agentPaths.changed, false);
  eq(r.allowlist.changed, false);
  eq(fs.readFileSync(sp, "utf8"), before);
  eq(fs.existsSync(sp + ".bak"), false);
  eq(r.agentPaths.error.includes(`add "${root}/agents-vibe" to the agent_paths`), true);
  eq(r.allowlist.error.includes(`add the depth patterns "${root}/skills/*"`), true);
  clean(root);
});

test("mergeVibeConfig: unclosed array opener anywhere forces safe-bail", () => {
  for (const withPaths of [true, false]) {
    const root = tmp(); const sp = path.join(root, "config.toml");
    const before = (withPaths ? `agent_paths = ["${root}/agents-vibe"]\n` : "")
      + 'theme = [\n  ["dark"],\n]\n';
    w(root, "config.toml", before);
    const r = gen.mergeVibeConfig(sp, root);
    eq(r.agentPaths.changed, false, String(withPaths));
    eq(r.allowlist.changed, false, String(withPaths));
    eq(fs.readFileSync(sp, "utf8"), before);
    eq(fs.existsSync(sp + ".bak"), false, String(withPaths));
    eq(r.agentPaths.error.includes(`add "${root}/agents-vibe" to the agent_paths`), true, String(withPaths));
    eq(r.allowlist.error.includes(`add the depth patterns "${root}/skills/*"`), true, String(withPaths));
    clean(root);
  }
});

test("mergeVibeConfig: suspicious escape in an existing element bails; legit escapes merge", () => {
  {
    const root = tmp(); const sp = path.join(root, "config.toml");
    const before = 'agent_paths = ["/a\\u0020b"]\n';
    w(root, "config.toml", before);
    const r = gen.mergeVibeConfig(sp, root);
    eq(r.agentPaths.changed, false);
    // the suspicious element is never edited or re-rendered; the independent
    // allowlist duty still appends its table without touching that line
    const out = fs.readFileSync(sp, "utf8");
    eq(out.startsWith('agent_paths = ["/a\\u0020b"]\n\n[tools.read_file]\n'), true);
    eq(out.includes(allowLine(root)), true);
    eq(r.agentPaths.error.includes(`add "${root}/agents-vibe" to the agent_paths`), true);
    clean(root);
  }
  {
    const root = tmp(); const sp = path.join(root, "config.toml");
    w(root, "config.toml", 'agent_paths = ["/a\\"b"]\n');
    const r = gen.mergeVibeConfig(sp, root);
    eq(r.agentPaths.changed, true);
    eq(fs.readFileSync(sp, "utf8"),
      `agent_paths = ["/a\\"b", "${root}/agents-vibe"]\n\n[tools.read_file]\n${allowLine(root)}\n`);
    clean(root);
  }
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

test("prune: generated vibe TOMLs removed by marker, user files survive", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" }]}));
  const generated = gen.renderVibeAgentTOML({ name: "orphan", description: "d", persona: "p" },
    [{ name: "a", dir: "/r/a", description: null }]);
  w(root, "agents-vibe/orphan.toml", generated);
  w(root, "agents-vibe/myown.toml", 'agent_type = "subagent"\ndescription = "mine"\n');
  const r = gen.prune(root, gen.loadManifest(root));
  eq(r.vibeAgents.join(","), "orphan");
  eq(fs.existsSync(path.join(root, "agents-vibe/orphan.toml")), false);
  eq(fs.existsSync(path.join(root, "agents-vibe/myown.toml")), true);
  clean(root);
});

test("renderRouterAgent: frontmatter shape and persona body", () => {
  const home = "/fake/home";
  const out = gen.renderRouterAgent({ root: "/fake/home/sr", home });
  eq(out.startsWith("---\nname: skill-router\n"), true);
  eq(/^description: "/.test(out.split("\n")[2]), true);
  eq(out.includes("inheritSkills: false"), true);
  eq(/^skills:/m.test(out), false);
  eq(/^skillPath:/m.test(out), false);
  eq(out.includes("/fake/home"), false);   // no home path leaks into the file
  eq(out.includes("~/sr/catalog/skill-catalog.md"), true);
  eq(out.includes("Recommend and stop"), true);
  eq(out.includes("digest"), true);
});

test("renderRouterAgent: real home gets ~-anchored catalog path", () => {
  const out = gen.renderRouterAgent();
  eq(out.includes("~/repositories/skill-router/catalog/skill-catalog.md"), true);
});

test("writeRouterAgent: writes, idempotent", () => {
  const root = tmp();
  const r = gen.writeRouterAgent(root);
  eq(r.written, true);
  const file = path.join(root, "agents", "skill-router.md");
  eq(fs.existsSync(file), true);
  const first = fs.readFileSync(file, "utf8");
  eq(gen.writeRouterAgent(root).written, true);
  eq(fs.readFileSync(file, "utf8"), first);
  clean(root);
});

test("prune: never removes the skill-router agent", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" }]}));
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "skill-router.md"), gen.renderRouterAgent());
  w(root, "agents/gone.md", "---\nname: gone\nskillPath: ../skills/gone\n---\np\n");
  const r = gen.prune(root, gen.loadManifest(root));
  eq(r.agents.join(","), "gone");
  eq(fs.existsSync(path.join(root, "agents", "skill-router.md")), true);
  clean(root);
});

test("renderSkillCatalog: sections, rows, ~-anchored paths, empty repos", () => {
  const home = tmp();
  const root = path.join(home, "sr");
  fs.mkdirSync(root, { recursive: true });
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "aaa", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "bbb", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "ccc", url: "https://github.com/x/y", description: "d", persona: "p" },
  ]}));
  skill(root, "skills/aaa/zeta");
  skill(root, "skills/aaa/alpha");
  const nod = path.join(root, "skills/bbb/beta");
  fs.mkdirSync(nod, { recursive: true });
  fs.writeFileSync(path.join(nod, "SKILL.md"), "---\nname: beta\n---\n# body\n");
  const out = gen.renderSkillCatalog(root, gen.loadManifest(root), { home });
  eq(out, [
    "# Skill catalog",
    "",
    "Generated by scripts/generate.mjs from repos.json — do not edit.",
    "",
    "## aaa",
    "",
    "- alpha: test skill — ~/sr/skills/aaa/alpha/SKILL.md",
    "- zeta: test skill — ~/sr/skills/aaa/zeta/SKILL.md",
    "",
    "## bbb",
    "",
    "- beta — ~/sr/skills/bbb/beta/SKILL.md",
    "",
    "## ccc",
    "",
    "(no skills yet)",
    "",
  ].join("\n"));
  clean(home);
});

test("renderSkillCatalog: duplicate names across repos stay distinguishable", () => {
  const home = tmp();
  const root = path.join(home, "sr");
  fs.mkdirSync(root, { recursive: true });
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "two", url: "https://github.com/x/y", description: "d", persona: "p" },
  ]}));
  skill(root, "skills/one/shared");
  skill(root, "skills/two/shared");
  const out = gen.renderSkillCatalog(root, gen.loadManifest(root), { home });
  eq(out.includes("## one"), true);
  eq(out.includes("- shared: test skill — ~/sr/skills/one/shared/SKILL.md"), true);
  eq(out.includes("## two"), true);
  eq(out.includes("- shared: test skill — ~/sr/skills/two/shared/SKILL.md"), true);
  clean(home);
});

test("writeSkillCatalog: writes file, counts skills, idempotent", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "one", url: "https://github.com/x/y", description: "d", persona: "p" },
    { name: "zero", url: "https://github.com/x/y", description: "d", persona: "p" },
  ]}));
  skill(root, "skills/one/a");
  skill(root, "skills/one/b");
  const m = gen.loadManifest(root);
  const r = gen.writeSkillCatalog(root, m);
  eq(r.skillCount, 2);
  const file = path.join(root, "catalog", "skill-catalog.md");
  eq(fs.existsSync(file), true);
  const first = fs.readFileSync(file, "utf8");
  gen.writeSkillCatalog(root, m);
  eq(fs.readFileSync(file, "utf8"), first);
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
