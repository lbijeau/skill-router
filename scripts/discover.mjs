import fs from "node:fs";
import path from "node:path";
import { NAME_RE } from "./common.mjs";

export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  const translated = escaped
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*");
  return new RegExp(`^${translated}$`);
}

const SKIP_DIRS = new Set([".git", "node_modules", "tests", "test"]);

function walkSkillDirs(dir, out = [], warnings = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  if (entries.some(e => e.isFile() && e.name === "SKILL.md")) out.push(dir);
  for (const e of entries) {
    if (e.isSymbolicLink() && e.name === "SKILL.md") {
      warnings.push(`symlinked SKILL.md skipped: ${path.join(dir, e.name)}`);
    }
  }
  const children = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(n => !n.startsWith(".") && !SKIP_DIRS.has(n))
    .sort();
  for (const n of children) walkSkillDirs(path.join(dir, n), out, warnings);
  return out;
}

const BLOCK_SCALAR_RE = /^[|>](?:[0-9]*[+-]?|[+-][0-9]*)$/;

function normalizeDescription(val) {
  if (val == null) return null;
  const s = String(val)
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s === "") return null;
  if (s.length <= 240) return s;
  for (let j = 0; j < 240; j++) {
    if ((s[j] === "." || s[j] === "!" || s[j] === "?") && s[j + 1] === " ") {
      return s.slice(0, j + 1);
    }
  }
  for (let j = 239; j >= 0; j--) {
    if (s[j] === " ") return s.slice(0, j) + "…";
  }
  return s.slice(0, 240) + "…";
}

export function parseSkillFrontmatter(content) {
  const lines = content.replace(/^\uFEFF/, "").split("\n");
  const out = { closed: false, name: null, description: null };
  if (lines[0].trimEnd() !== "---") return out;
  let i = 1;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (line === "---") { out.closed = true; break; }
    const d = line.match(/^description:[ \t]*(.*)$/);
    if (d) {
      let val = d[1].trim();
      if (BLOCK_SCALAR_RE.test(val)) {
        const parts = [];
        i++;
        while (i < lines.length) {
          const blk = lines[i];
          if (blk === "" || /^[ \t]/.test(blk)) {
            if (blk.trim() !== "") parts.push(blk.trim());
            i++;
          } else break;
        }
        val = parts.join(" ");
        out.description = normalizeDescription(val);
        continue;
      }
      if (val.length >= 2
        && ((val[0] === '"' && val[val.length - 1] === '"')
          || (val[0] === "'" && val[val.length - 1] === "'"))) {
        val = val.slice(1, -1);
      }
      out.description = normalizeDescription(val);
    } else {
      const m = line.match(/^name:[ \t]*(.*?)[ \t]*$/);
      if (m) out.name = m[1];
    }
    i++;
  }
  return out;
}

export function discoverSkills(cloneDir, entry) {
  const walkRoot = path.join(cloneDir, entry.skillSource ?? ".");
  const excludes = (entry.pathExclude ?? []).map(globToRegExp);
  const warnings = [];
  const skills = [];
  const dropped = [];
  const byName = new Map();
  for (const dir of walkSkillDirs(walkRoot, [], warnings)) {
    const relDir = path.relative(cloneDir, dir);
    if (excludes.some(re => re.test(relDir))) continue;
    const file = path.join(dir, "SKILL.md");
    let content;
    try { content = fs.readFileSync(file, "utf8"); }
    catch (e) { warnings.push(`unreadable ${file}: ${e.message}`); continue; }
    if (content.replace(/^\uFEFF/, "").split("\n")[0].trimEnd() !== "---") {
      warnings.push(`malformed frontmatter in ${file}: no opening ---`);
      continue;
    }
    const parsed = parseSkillFrontmatter(content);
    if (!parsed.closed) {
      warnings.push(`malformed frontmatter in ${file}: no closing ---`);
      continue;
    }
    let name = parsed.name;
    if (name === null || name === "") name = path.basename(dir);
    if (!NAME_RE.test(name) || name.length > 64) {
      warnings.push(`unexpressible skill name: ${JSON.stringify(name)} in ${dir}`);
      continue;
    }
    const existing = byName.get(name);
    if (existing) {
      dropped.push({ name, keptDir: existing.dir, droppedDir: dir });
    } else {
      const ref = { name, dir, description: parsed.description };
      byName.set(name, ref);
      skills.push(ref);
    }
  }
  return { skills, dropped, warnings };
}
