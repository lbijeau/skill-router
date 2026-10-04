#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
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

process.exitCode = await (async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("PASS", t.name); }
    catch (e) { failed++; console.log("FAIL", t.name, "\n  " + e.message); }
  }
  console.log(failed ? `${failed} test(s) failed` : "all green");
  return failed ? 1 : 0;
})();
