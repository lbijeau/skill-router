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
