import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Full double-quoted YAML scalar: `description: ${yamlQuote(x)}`.
export function yamlQuote(s) {
  return '"' + String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n") + '"';
}

export function normalizeText(s, { keepNewlines = false } = {}) {
  let out = String(s)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ");
  if (!keepNewlines) out = out.replace(/\n/g, " ");
  return out.replace(/[ ]{2,}/g, " ").trim();
}

// Home-anchored paths keep the committed Vibe artifacts machine-independent
// (no username baked into git). Vibe's file tools expanduser() every path, so
// ~ resolves at runtime; outside home the absolute path is the only anchor.
export function tildePath(absPath, home = os.homedir()) {
  const p = path.resolve(absPath);
  const h = path.resolve(home);
  if (p === h) return "~";
  if (p.startsWith(h + path.sep)) return "~/" + p.slice(h.length + 1);
  return p;
}

// One `- name: description — ~/path/SKILL.md` row per skill; `escape` is the
// target format's string escaper (identity for markdown).
export function skillRows(skills, home, escape = x => x) {
  return skills.map(s => {
    const file = tildePath(path.join(s.dir, "SKILL.md"), home);
    return s.description
      ? `- ${s.name}: ${escape(s.description)} — ${file}`
      : `- ${s.name} — ${file}`;
  });
}

export const ROUTER_AGENT_NAME = "skill-router";

export const ROUTER_DESCRIPTION = "Routes a described situation to the best skill across all pinned repos; returns skill, path, and digest";

// Router persona body, no trailing newline element; shared by pi and Claude.
export function routerBodyLines(root, home) {
  const catalogPath = tildePath(path.join(root, "catalog", "skill-catalog.md"), home);
  return [
    "You are the skill router over every repo pinned in this repo's manifest.",
    `First, read the catalog at ${catalogPath}. It lists every skill in every pinned repo, with a one-line description and the path to its SKILL.md.`,
    "",
    "Match the caller's situation to the catalog. When two skills are close, open both SKILL.md files and say which one fits and why the other does not.",
    "",
    "Open the winning SKILL.md and return: the skill name, its path, why it fits, and a short digest of the real file. Never answer from the catalog description alone.",
    "",
    "Recommend and stop. Do not execute the skill, edit files, or start the work.",
    "",
    "If nothing fits, say so plainly; do not force a nearest match.",
  ];
}

export function atomicWrite(file, content, mode) {
  const tmpf = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmpf, content);
  if (mode !== undefined) fs.chmodSync(tmpf, mode);
  fs.renameSync(tmpf, file);
}

export function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export function realPath(p) {
  let cur = p;
  let tail = "";
  while (true) {
    try { return path.join(fs.realpathSync(cur), tail); }
    catch {
      const next = path.dirname(cur);
      if (next === cur) return path.resolve(p);
      tail = path.join(path.basename(cur), tail);
      cur = next;
    }
  }
}

export const STATE = { IN_SYNC: "in-sync", STALE: "stale", MISSING: "missing", NONE: "—", NA: "n/a", ERROR: "error" };
