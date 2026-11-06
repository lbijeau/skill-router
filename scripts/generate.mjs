import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REQUIRED_FIELDS = ["url", "description", "persona"];
const URL_RE = /^(https:\/\/[\w.-]+(?:\/[\w._~-]+)+\/?|file:\/\/\/[\w.~\/-]+)$/;

export function loadManifest(root) {
  const file = path.join(root, "repos.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read manifest ${file}: ${e.message}`);
  }
  if (!Array.isArray(parsed.repos)) {
    throw new Error("manifest: repos must be an array");
  }
  const seen = new Set();
  for (const entry of parsed.repos) {
    if (typeof entry.name !== "string" || !NAME_RE.test(entry.name) || entry.name.length > 64) {
      throw new Error(`invalid name: ${JSON.stringify(entry?.name)}`);
    }
    for (const field of REQUIRED_FIELDS) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(`${entry.name}: missing ${field}`);
      }
    }
    if (entry.pathExclude !== undefined) {
      if (!Array.isArray(entry.pathExclude)
        || entry.pathExclude.some(p => typeof p !== "string" || p.length === 0)) {
        throw new Error(`${entry.name}: pathExclude must be an array of strings`);
      }
    }
    if (entry.skillSource !== undefined) {
      if (typeof entry.skillSource !== "string" || entry.skillSource.length === 0) {
        throw new Error(`${entry.name}: skillSource must be a string`);
      }
      const src = path.normalize(entry.skillSource);
      if (path.isAbsolute(src) || src.split(/[\\/]+/).includes("..")) {
        throw new Error(`${entry.name}: skillSource must be a relative path inside the clone`);
      }
    }
    if (seen.has(entry.name)) {
      throw new Error(`duplicate name: ${entry.name}`);
    }
    seen.add(entry.name);
    if (!URL_RE.test(entry.url)) {
      throw new Error(`${entry.name}: url must be an https GitHub URL or file:// mirror`);
    }
  }
  return { repos: parsed.repos };
}

export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  const translated = escaped
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*");
  return new RegExp(`^${translated}$`);
}

const SKIP_DIRS = new Set([".git", "node_modules", "tests", "test"]);

function walkSkillDirs(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  if (entries.some(e => e.isFile() && e.name === "SKILL.md")) out.push(dir);
  const children = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(n => !n.startsWith(".") && !SKIP_DIRS.has(n))
    .sort();
  for (const n of children) walkSkillDirs(path.join(dir, n), out);
  return out;
}

const BLOCK_SCALAR_RE = /^[|>](?:[0-9]*[+-]?|[+-][0-9]*)$/;

function normalizeDescription(val) {
  if (val == null) return null;
  const s = String(val)
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
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
  for (const dir of walkSkillDirs(walkRoot)) {
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

export function renderAgentFile(entry, skillNames) {
  const description = entry.description
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return [
    "---",
    `name: ${entry.name}`,
    `description: "${description}"`,
    "inheritSkills: false",
    `skills: ${skillNames.join(", ")}`,
    `skillPath: ../skills/${entry.name}`,
    "---",
    entry.persona,
    "",
  ].join("\n");
}

export const VIBE_MARKER = "You have no skill tool; if one is offered anyway, do not use it.";
export const VIBE_BOILERPLATE = [
  VIBE_MARKER,
  "Your skills are files. When a task matches one, read its SKILL.md with read_file and follow it.",
  "If a skill's instructions tell you to use or load another skill, read that skill's SKILL.md the same way and follow it.",
  "If a read comes back truncated, say so.",
].join("\n");

function normalizeTomlText(s, { keepNewlines = false } = {}) {
  let out = String(s)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ");
  if (!keepNewlines) out = out.replace(/\n/g, " ");
  return out.replace(/[ ]{2,}/g, " ").trim();
}

function tomlEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

export function renderVibeAgentTOML(entry, skills, { home } = {}) {
  const homeDir = home ?? os.homedir();
  const description = tomlEscape(normalizeTomlText(entry.description));
  const persona = tomlEscape(normalizeTomlText(entry.persona, { keepNewlines: true }));
  const rows = (skills ?? []).map(s => {
    const file = tildePath(path.join(s.dir, "SKILL.md"), homeDir);
    return s.description
      ? `- ${s.name}: ${tomlEscape(s.description)} — ${file}`
      : `- ${s.name} — ${file}`;
  });
  return [
    'agent_type = "subagent"',
    `description = "${description}"`,
    'disabled_tools = ["skill"]',
    'instructions = """',
    persona,
    "",
    VIBE_BOILERPLATE,
    "",
    ...rows,
    '"""',
    "",
  ].join("\n");
}

export function writeAgentFiles(root, manifest, skip = new Set()) {
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const written = [], removed = [], warnings = [], dropped = [];
  for (const entry of manifest.repos) {
    if (skip.has(entry.name)) continue;
    const found = discoverSkills(path.join(root, "skills", entry.name), entry);
    warnings.push(...found.warnings);
    dropped.push(...found.dropped);
    const file = path.join(agentsDir, `${entry.name}.md`);
    if (found.skills.length > 0) {
      fs.writeFileSync(file, renderAgentFile(entry, found.skills.map(s => s.name)));
      written.push(entry.name);
    } else if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed.push(entry.name);
    }
  }
  return { written, removed, warnings, dropped };
}

export function writeVibeAgentFiles(root, manifest, skip = new Set()) {
  const agentsDir = path.join(root, "agents-vibe");
  fs.mkdirSync(agentsDir, { recursive: true });
  const written = [], removed = [];
  for (const entry of manifest.repos) {
    if (skip.has(entry.name)) continue;
    const found = discoverSkills(path.join(root, "skills", entry.name), entry);
    const file = path.join(agentsDir, `${entry.name}.toml`);
    if (found.skills.length > 0) {
      fs.writeFileSync(file, renderVibeAgentTOML(entry, found.skills));
      written.push(entry.name);
    } else if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed.push(entry.name);
    }
  }
  return { written, removed };
}

export const ROUTER_AGENT_NAME = "skill-router";

// Global skills live committed under global-skills/<name>/SKILL.md and are
// synced (overwritten) into the pi skills home on every install/update: they
// are generated-style boilerplate, and user edits do not survive updates.
export function syncGlobalSkills(root, skillsHome) {
  const home = skillsHome ?? path.join(os.homedir(), ".pi/agent/skills");
  const srcDir = path.join(root, "global-skills");
  const written = [];
  let skipped = 0;
  if (!fs.existsSync(srcDir)) return { written, skipped };
  for (const d of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!d.isDirectory()) { skipped++; continue; }
    const src = path.join(srcDir, d.name, "SKILL.md");
    if (!fs.existsSync(src)) { skipped++; continue; }
    const dest = path.join(home, d.name, "SKILL.md");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(src));
    written.push(dest);
  }
  return { written, skipped };
}

export function renderRouterAgent({ root = REPO_ROOT, home } = {}) {
  const catalogPath = tildePath(path.join(root, "catalog", "skill-catalog.md"), home);
  return [
    "---",
    `name: ${ROUTER_AGENT_NAME}`,
    'description: "Routes a described situation to the best skill across all pinned repos; returns skill, path, and digest"',
    "inheritSkills: false",
    "---",
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
    "",
  ].join("\n");
}

export function writeRouterAgent(root) {
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const file = path.join(agentsDir, `${ROUTER_AGENT_NAME}.md`);
  fs.writeFileSync(file, renderRouterAgent({ root }));
  return { file, written: true };
}

// The catalog is the router subagent's source of truth: every skill in every
// clone, one row each, ~-anchored so the committed file is machine-independent.
export function renderSkillCatalog(root, manifest, { home } = {}) {
  const homeDir = home ?? os.homedir();
  const parts = [
    "# Skill catalog",
    "",
    "Generated by scripts/generate.mjs from repos.json — do not edit.",
    "",
  ];
  for (const entry of manifest.repos) {
    parts.push(`## ${entry.name}`, "");
    const found = discoverSkills(path.join(root, "skills", entry.name), entry);
    if (found.skills.length === 0) {
      parts.push("(no skills yet)", "");
      continue;
    }
    const rows = [...found.skills].sort((a, b) => a.name.localeCompare(b.name))
      .map(s => {
        const file = tildePath(path.join(s.dir, "SKILL.md"), homeDir);
        return s.description
          ? `- ${s.name}: ${s.description} — ${file}`
          : `- ${s.name} — ${file}`;
      });
    parts.push(...rows, "");
  }
  return parts.join("\n");
}

export function writeSkillCatalog(root, manifest) {
  const content = renderSkillCatalog(root, manifest);
  let skillCount = 0;
  for (const entry of manifest.repos) {
    skillCount += discoverSkills(path.join(root, "skills", entry.name), entry).skills.length;
  }
  const dir = path.join(root, "catalog");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "skill-catalog.md");
  fs.writeFileSync(file, content);
  return { written: file, skillCount };
}

export function prune(root, manifest) {
  const agents = [], clones = [], vibeAgents = [];
  const names = new Set(manifest.repos.map(e => e.name));
  const agentsDir = path.join(root, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir)) {
      const m = f.match(/^(.*)\.md$/);
      if (m && !names.has(m[1])) {
        let generated = false;
        try {
          generated = fs.readFileSync(path.join(agentsDir, f), "utf8")
            .includes(`skillPath: ../skills/${m[1]}`);
        } catch { /* unreadable: leave it alone */ }
        if (generated) {
          fs.rmSync(path.join(agentsDir, f));
          agents.push(m[1]);
        }
      }
    }
  }
  const vibeDir = path.join(root, "agents-vibe");
  if (fs.existsSync(vibeDir)) {
    for (const f of fs.readdirSync(vibeDir)) {
      const m = f.match(/^(.*)\.toml$/);
      if (m && !names.has(m[1])) {
        let generated = false;
        try {
          generated = fs.readFileSync(path.join(vibeDir, f), "utf8").includes(VIBE_MARKER);
        } catch { /* unreadable: leave it alone */ }
        if (generated) {
          fs.rmSync(path.join(vibeDir, f));
          vibeAgents.push(m[1]);
        }
      }
    }
  }
  const skillsDir = path.join(root, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (d.isDirectory() && !names.has(d.name)) {
        fs.rmSync(path.join(skillsDir, d.name), { recursive: true, force: true });
        clones.push(d.name);
      }
    }
  }
  return { agents, clones, vibeAgents };
}

function expandTilde(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function atomicWrite(file, content) {
  const tmpf = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmpf, content);
  fs.renameSync(tmpf, file);
}

function realPath(p) {
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

export function mergeSettings(settingsPath, repoRoot) {
  const home = os.homedir();
  const underHome = repoRoot === home || repoRoot.startsWith(home + path.sep);
  const entry = underHome
    ? "~/" + path.relative(home, repoRoot) + "/agents"
    : path.join(repoRoot, "agents");
  const resolved = path.resolve(repoRoot, "agents");

  let existing;
  const existed = fs.existsSync(settingsPath);
  if (existed) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
    catch { return { changed: false, entry, error: "unparseable settings file, merge skipped" }; }
  }

  if (!existed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    atomicWrite(settingsPath,
      JSON.stringify({ subagents: { agentScanDirs: [entry] } }, null, 2) + "\n");
    return { changed: true, entry };
  }

  const list = Array.isArray(existing?.subagents?.agentScanDirs)
    ? existing.subagents.agentScanDirs : [];
  const already = list.some(d => realPath(expandTilde(d)) === realPath(resolved));
  if (already) return { changed: false, entry };

  atomicWrite(settingsPath + ".bak", fs.readFileSync(settingsPath, "utf8"));
  const next = { ...existing,
    subagents: { ...existing?.subagents, agentScanDirs: [...list, entry] } };
  atomicWrite(settingsPath, JSON.stringify(next, null, 2) + "\n");
  return { changed: true, entry };
}

function readToml(file) {
  let raw = fs.readFileSync(file, "utf8");
  const hadBom = raw.startsWith("\uFEFF");
  if (hadBom) raw = raw.slice(1);
  const firstNl = raw.indexOf("\n");
  const eol = firstNl > 0 && raw[firstNl - 1] === "\r" ? "\r\n" : "\n";
  return { raw, hadBom, eol, lines: raw.split(/\r?\n/) };
}

function writeTomlLines(file, parsed, lines) {
  atomicWrite(file, (parsed.hadBom ? "\uFEFF" : "") + lines.join(parsed.eol));
}

function tomlArrayElements(str) {
  const els = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /[\s,]/.test(str[i])) i++;
    if (i >= str.length) break;
    const q = str[i];
    if (q !== '"' && q !== "'") return null;
    let j = i + 1;
    while (j < str.length && str[j] !== q) {
      if (q === '"' && str[j] === "\\") j++;
      j++;
    }
    if (j >= str.length) return null;
    els.push(str.slice(i, j + 1));
    i = j + 1;
  }
  return els;
}

function tomlElementContent(el) {
  const q = el[0];
  let c = el.slice(1, -1);
  if (q === '"') c = c.replace(/\\(.)/g, "$1");
  return c;
}

function tomlArrayContents(els) {
  const out = [];
  for (const el of els) {
    if (el[0] === '"' && /\\[^"\\]/.test(el.slice(1, -1))) return null;
    out.push(tomlElementContent(el));
  }
  return out;
}

function tomlBasicString(s) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function mergeVibeConfig(configPath, repoRoot) {
  const result = { agentPaths: { changed: false }, allowlist: { changed: false } };
  const agentsEntry = path.join(repoRoot, "agents-vibe");
  // Vibe matches absolute allowlist patterns with component-strict pathlib
  // rules: a single `**` matches nothing below the base. One pattern per
  // depth (1..8) covers every real skill path.
  const allowPatterns = Array.from({ length: 8 },
    (_, i) => path.join(repoRoot, "skills") + "/*".repeat(i + 1));
  const allowLine = `allowlist = [${allowPatterns.map(tomlBasicString).join(", ")}]`;
  const agentErr = `vibe config: agent_paths unmergeable; add "${agentsEntry}" to the agent_paths array in ${configPath} manually`;
  const allowErr = `vibe config: [tools.read_file] allowlist unmergeable; add the depth patterns "${allowPatterns[0]}" through "${allowPatterns[allowPatterns.length - 1]}" to the allowlist array in ${configPath} manually`;

  let existed = false;
  let parsed = null;
  try {
    existed = fs.existsSync(configPath);
    if (existed) parsed = readToml(configPath);
  } catch (e) {
    const err = `vibe config: unreadable ${configPath}: ${e.message}`;
    result.agentPaths = { changed: false, error: err };
    result.allowlist = { changed: false, error: err };
    return result;
  }

  if (!existed) {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      atomicWrite(configPath,
        `agent_paths = ["${agentsEntry}"]\n\n[tools.read_file]\n${allowLine}\n`);
      result.agentPaths = { changed: true };
      result.allowlist = { changed: true };
    } catch (e) {
      const err = `vibe config: cannot create ${configPath}: ${e.message}`;
      result.agentPaths = { changed: false, error: err };
      result.allowlist = { changed: false, error: err };
    }
    return result;
  }

  if (parsed.raw.includes('"""') || parsed.raw.includes("'''")) {
    result.agentPaths = { changed: false, error: agentErr };
    result.allowlist = { changed: false, error: allowErr };
    return result;
  }

  // Conservative on purpose: a trailing comma or an empty array opener means a
  // multi-line array whose continuation lines can defeat the line grammar
  // (a bracket-initial element looks like a table header). Refuse, don't guess.
  if (parsed.lines.some(l => /=\s*\[\s*$/.test(l) || l.trimEnd().endsWith(","))) {
    result.agentPaths = { changed: false, error: agentErr };
    result.allowlist = { changed: false, error: allowErr };
    return result;
  }

  const lines = [...parsed.lines];
  let dirty = false;

  const headerIdx = lines.findIndex(l => /^\s*\[/.test(l));
  const regionEnd = headerIdx === -1 ? lines.length : headerIdx;
  const hits = [];
  for (let i = 0; i < regionEnd; i++) {
    const m = lines[i].match(/^\s*agent_paths\s*=\s*(.*)$/);
    if (m) hits.push({ idx: i, rest: m[1] });
  }

  if (hits.length > 1) {
    result.agentPaths = { changed: false, error: agentErr };
  } else if (hits.length === 0) {
    let insertAt = regionEnd;
    if (headerIdx !== -1) {
      while (insertAt > 0 && /^\s*#/.test(lines[insertAt - 1])) insertAt--;
    } else if (lines.length > 0 && lines[lines.length - 1] === "") {
      insertAt = lines.length - 1;
    }
    lines.splice(insertAt, 0, `agent_paths = ["${agentsEntry}"]`);
    if (headerIdx === -1 && lines[lines.length - 1] !== "") lines.push("");
    dirty = true;
    result.agentPaths = { changed: true };
  } else {
    const { idx, rest } = hits[0];
    const arrMatch = rest.match(/^\s*\[(.*)\]\s*$/);
    const els = arrMatch ? tomlArrayElements(arrMatch[1]) : null;
    const contents = els ? tomlArrayContents(els) : null;
    if (contents === null) {
      result.agentPaths = { changed: false, error: agentErr };
    } else if (contents.some(c => realPath(expandTilde(c)) === realPath(agentsEntry))) {
      result.agentPaths = { changed: false };
    } else {
      lines[idx] = `agent_paths = [${[...contents.map(tomlBasicString), tomlBasicString(agentsEntry)].join(", ")}]`;
      dirty = true;
      result.agentPaths = { changed: true };
    }
  }

  // Recognized header spellings (inner whitespace, quoted key, trailing
  // comment) are merged under; anything else that mentions tools.read_file
  // (array-of-tables, sub-tables, dotted keys, keys under [tools], inline
  // tables) is refused rather than risked.
  const readFileHeaderRe = /^\s*\[\s*tools\s*\.\s*["']?read_file["']?\s*\]\s*(?:#.*)?$/;
  const exactHeader = lines.findIndex(l => readFileHeaderRe.test(l));
  const looseReadFile = exactHeader === -1 && lines.some(l =>
    (/^\s*\[/.test(l) && /tools\s*\.\s*["']?read_file/.test(l))
    || /^\s*["']?tools\s*\.\s*["']?read_file/.test(l)
    || /^\s*["']?read_file\s*[.=]/.test(l)
    || /tools\s*=\s*\{/.test(l)
    || /read_file\s*=\s*\{/.test(l));
  if (looseReadFile) {
    result.allowlist = { changed: false, error: allowErr };
  } else if (exactHeader === -1) {
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.splice(lines.length - 1, 0, "", "[tools.read_file]", allowLine);
    dirty = true;
    result.allowlist = { changed: true };
  } else {
    let sectionEnd = lines.length;
    for (let i = exactHeader + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { sectionEnd = i; break; }
    }
    const aHits = [];
    for (let i = exactHeader + 1; i < sectionEnd; i++) {
      const m = lines[i].match(/^\s*allowlist\s*=\s*(.*)$/);
      if (m) aHits.push({ idx: i, rest: m[1] });
    }
    if (aHits.length > 1) {
      result.allowlist = { changed: false, error: allowErr };
    } else if (aHits.length === 0) {
      lines.splice(exactHeader + 1, 0, allowLine);
      dirty = true;
      result.allowlist = { changed: true };
    } else {
      const { idx, rest } = aHits[0];
      const arrMatch = rest.match(/^\s*\[(.*)\]\s*$/);
      const els = arrMatch ? tomlArrayElements(arrMatch[1]) : null;
      const contents = els ? tomlArrayContents(els) : null;
      if (contents === null) {
        result.allowlist = { changed: false, error: allowErr };
      } else {
        const missing = allowPatterns.filter(p => !contents.includes(p));
        if (missing.length === 0) {
          result.allowlist = { changed: false };
        } else {
          lines[idx] = `allowlist = [${[...contents.map(tomlBasicString),
            ...missing.map(tomlBasicString)].join(", ")}]`;
          dirty = true;
          result.allowlist = { changed: true };
        }
      }
    }
  }

  if (!dirty) return result;
  try {
    atomicWrite(configPath + ".bak", (parsed.hadBom ? "\uFEFF" : "") + parsed.raw);
    writeTomlLines(configPath, parsed, lines);
  } catch (e) {
    const err = `vibe config: write failed: ${e.message}`;
    if (result.agentPaths.changed) result.agentPaths = { changed: false, error: err };
    if (result.allowlist.changed) result.allowlist = { changed: false, error: err };
  }
  return result;
}

export function cloneState(cloneDir) {
  if (!fs.existsSync(cloneDir)) return "missing";
  if (!fs.existsSync(path.join(cloneDir, ".git"))) return "not-a-repo";
  const st = spawnSync("git", ["-C", cloneDir, "status", "--porcelain"], { encoding: "utf8" });
  if (st.status !== 0) return "not-a-repo";
  return st.stdout.trim() === "" ? "ok" : "dirty";
}

export function statusOf(root, manifest, opts = {}) {
  const rows = [];
  const dropped = [];
  const warnings = [];
  const userAgentsDir = opts.userAgentsDir
    ?? path.join(process.env.VIBE_HOME || path.join(os.homedir(), ".vibe"), "agents");
  for (const entry of manifest.repos) {
    const cloneDir = path.join(root, "skills", entry.name);
    const clone = cloneState(cloneDir);
    const found = discoverSkills(cloneDir, entry);
    dropped.push(...found.dropped.map(d =>
      `${d.name}: kept ${d.keptDir}, dropped ${d.droppedDir}`));
    const agentFile = path.join(root, "agents", `${entry.name}.md`);
    let agent;
    if (found.skills.length === 0) {
      agent = fs.existsSync(agentFile) ? "stale" : "in-sync";
    } else if (!fs.existsSync(agentFile)) {
      agent = "missing";
    } else {
      const onDisk = fs.readFileSync(agentFile, "utf8");
      const expected = renderAgentFile(entry, found.skills.map(s => s.name));
      agent = onDisk === expected ? "in-sync" : "stale";
    }
    const tomlFile = path.join(root, "agents-vibe", `${entry.name}.toml`);
    let vibe;
    if (found.skills.length === 0) {
      vibe = fs.existsSync(tomlFile) ? "stale" : "—";
    } else if (!fs.existsSync(tomlFile)) {
      vibe = "missing";
    } else {
      const onDisk = fs.readFileSync(tomlFile, "utf8");
      const expected = renderVibeAgentTOML(entry, found.skills);
      vibe = onDisk === expected ? "in-sync" : "stale";
    }
    rows.push({ name: entry.name, clone, skills: found.skills.length, agent, vibe });
  }
  if (fs.existsSync(userAgentsDir)) {
    for (const r of rows) {
      if (fs.existsSync(path.join(userAgentsDir, `${r.name}.toml`))) {
        warnings.push(`${r.name}: name collision — also defined in ${userAgentsDir}`);
      }
    }
  }
  const catalogFile = path.join(root, "catalog", "skill-catalog.md");
  let catalog;
  if (!fs.existsSync(catalogFile)) {
    catalog = "missing";
  } else {
    const onDisk = fs.readFileSync(catalogFile, "utf8");
    catalog = onDisk === renderSkillCatalog(root, manifest) ? "in-sync" : "stale";
  }
  const routerFile = path.join(root, "agents", `${ROUTER_AGENT_NAME}.md`);
  let router;
  if (!fs.existsSync(routerFile)) {
    router = "missing";
  } else {
    const onDisk = fs.readFileSync(routerFile, "utf8");
    router = onDisk === renderRouterAgent({ root }) ? "in-sync" : "stale";
  }
  const ok = rows.every(r => r.clone === "ok" && r.agent === "in-sync"
    && (r.vibe === "in-sync" || r.vibe === "—")) && catalog === "in-sync"
    && router === "in-sync";
  return { rows, dropped, warnings, catalog, router, exitCode: ok ? 0 : 1 };
}

function printStatus(root, manifest) {
  const { rows, dropped, warnings, catalog, router, exitCode } = statusOf(root, manifest);
  console.log(["NAME", "CLONE", "SKILLS", "AGENT", "VIBE"].reduce((a, h, i) => a + h.padEnd([14, 10, 7, 10, 10][i]), "") + "CATALOG    ROUTER");
  console.log(catalog.padEnd(10) + router);
  for (const r of rows) {
    console.log(r.name.padEnd(14) + r.clone.padEnd(10) + String(r.skills).padEnd(7)
      + r.agent.padEnd(10) + r.vibe);
  }
  for (const d of dropped) console.log(d);
  for (const x of warnings) console.log(x);
  return exitCode;
}

function runFlow(root, settingsPath, vibeConfigPath, mode) {
  const manifest = loadManifest(root);
  const report = [];
  let anyFailed = false;
  const oldSkillSets = new Map();
  if (mode === "update") {
    for (const entry of manifest.repos) {
      const f = path.join(root, "agents", `${entry.name}.md`);
      if (fs.existsSync(f)) {
        const m = fs.readFileSync(f, "utf8").match(/^skills:[ \t]*(.*)$/m);
        if (m) oldSkillSets.set(entry.name, new Set(m[1].split(", ").filter(Boolean)));
      }
    }
  }
  const states = [];
  const failed = new Set();
  for (const entry of manifest.repos) {
    const cloneDir = path.join(root, "skills", entry.name);
    const doClone = () => {
      const r = spawnSync("git", ["clone", "--depth", "1", entry.url, cloneDir], { encoding: "utf8" });
      if (r.status !== 0) {
        const last = (r.stderr || "git clone failed").trim().split("\n").pop();
        report.push(`${entry.name}: clone failed (${last})`);
        failed.add(entry.name);
        anyFailed = true;
        return false;
      }
      return true;
    };
    let state;
    if (!fs.existsSync(cloneDir)) {
      if (!doClone()) continue;
      state = "cloned";
    } else if (!fs.existsSync(path.join(cloneDir, ".git"))) {
      fs.rmSync(cloneDir, { recursive: true, force: true });
      if (!doClone()) continue;
      state = "cloned";
    } else {
      if (mode === "update") {
        const cur = spawnSync("git", ["-C", cloneDir, "remote", "get-url", "origin"], { encoding: "utf8" });
        if (cur.status === 0 && cur.stdout.trim() !== entry.url) {
          report.push(`${entry.name}: url changed, re-cloning`);
          fs.rmSync(cloneDir, { recursive: true, force: true });
          if (!doClone()) continue;
          state = "cloned";
        } else {
          const p = spawnSync("git", ["-C", cloneDir, "pull", "--ff-only"], { encoding: "utf8" });
          if (p.status !== 0) {
            report.push(`${entry.name}: pull failed (left as-is)`);
            anyFailed = true;
          }
          state = cloneState(cloneDir) === "dirty" ? "reused (dirty)" : "reused";
        }
      } else {
        state = cloneState(cloneDir) === "dirty" ? "reused (dirty)" : "reused";
      }
    }
    states.push({ entry, state });
  }
  const genResult = writeAgentFiles(root, manifest, failed);
  for (const warn of genResult.warnings) report.push(warn);
  for (const d of genResult.dropped) {
    report.push(`${d.name}: kept ${d.keptDir}, dropped ${d.droppedDir}`);
  }
  for (const name of genResult.removed) {
    report.push(`${name}: 0 skills, removed stale agent`);
  }
  const vibeResult = writeVibeAgentFiles(root, manifest, failed);
  for (const name of vibeResult.removed) {
    report.push(`${name}: 0 skills, removed stale vibe agent`);
  }
  const catalogResult = writeSkillCatalog(root, manifest);
  report.push(`catalog: ${catalogResult.skillCount} skills written to catalog/skill-catalog.md`);
  writeRouterAgent(root);
  report.push(`router agent: ${ROUTER_AGENT_NAME} written to agents/${ROUTER_AGENT_NAME}.md`);
  const synced = syncGlobalSkills(root);
  for (const f of synced.written) {
    report.push(`global skill: ${path.basename(path.dirname(f))} synced to ${tildePath(f)}`);
  }
  const piWritten = new Set(genResult.written);
  const vibeWritten = new Set(vibeResult.written);
  for (const { entry, state } of states) {
    const found = discoverSkills(path.join(root, "skills", entry.name), entry);
    const names = found.skills.map(s => s.name);
    const targets = [];
    if (piWritten.has(entry.name)) targets.push("pi");
    if (vibeWritten.has(entry.name)) targets.push("vibe");
    report.push(`${entry.name}: ${state}, ${found.skills.length} skills, ` +
      (found.skills.length ? `agent written (${targets.join(", ")})` : "no agent"));
    if (mode === "update") {
      const old = oldSkillSets.get(entry.name) ?? new Set();
      const added = names.filter(n => !old.has(n));
      const gone = [...old].filter(n => !names.includes(n));
      if (added.length || gone.length) {
        const parts = [];
        if (added.length) parts.push(`+${added.length} (${added.join(", ")})`);
        if (gone.length) parts.push(`-${gone.length} (${gone.join(", ")})`);
        report.push(`${entry.name}: ${parts.join(", ")}`);
      }
    }
  }
  const pruned = prune(root, manifest);
  for (const a of pruned.agents) report.push(`pruned ${a} (agent)`);
  for (const v of pruned.vibeAgents) report.push(`pruned ${v} (vibe agent)`);
  for (const c of pruned.clones) report.push(`pruned ${c} (clone)`);
  const settings = mergeSettings(settingsPath, root);
  if (settings.error) {
    report.push(`settings: skipped (${settings.error})`);
  } else {
    report.push(settings.changed
      ? `settings: added ${settings.entry}`
      : `settings: already configured (${settings.entry})`);
  }
  if (vibeConfigPath) {
    const vc = mergeVibeConfig(vibeConfigPath, root);
    report.push(vc.agentPaths.error
      ? `vibe config: agent_paths skipped (${vc.agentPaths.error})`
      : vc.agentPaths.changed
        ? `vibe config: agent_paths added ${path.join(root, "agents-vibe")}`
        : "vibe config: agent_paths already configured");
    report.push(vc.allowlist.error
      ? `vibe config: allowlist skipped (${vc.allowlist.error})`
      : vc.allowlist.changed
        ? `vibe config: allowlist added ${path.join(root, "skills")}/* (+${7} depth patterns)`
        : "vibe config: allowlist already configured");
  }
  report.push("reminder: run /reload (or restart Vibe) to pick up new agents");
  report.push("reminder: enabled_agents / disabled_agents config filters override agent discovery");
  return { exitCode: anyFailed ? 1 : 0, report };
}

const DEFAULT_SETTINGS = () => path.join(os.homedir(), ".pi/agent/settings.json");
const DEFAULT_VIBE_CONFIG = () => path.join(process.env.VIBE_HOME || path.join(os.homedir(), ".vibe"), "config.toml");
export function runInstall(root, settingsPath, vibeConfigPath) {
  return runFlow(root, settingsPath ?? DEFAULT_SETTINGS(), vibeConfigPath ?? DEFAULT_VIBE_CONFIG(), "install");
}
export function runUpdate(root, settingsPath, vibeConfigPath) {
  return runFlow(root, settingsPath ?? DEFAULT_SETTINGS(), vibeConfigPath ?? DEFAULT_VIBE_CONFIG(), "update");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cmd = process.argv[2];
  try {
    if (cmd === "status") {
      process.exit(printStatus(REPO_ROOT, loadManifest(REPO_ROOT)));
    }
    if (cmd === "install" || cmd === "update") {
      const r = cmd === "install"
        ? runInstall(REPO_ROOT)
        : runUpdate(REPO_ROOT);
      for (const line of r.report) console.log(line);
      process.exit(r.exitCode);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
  console.error("usage: generate.mjs <install|update|status>"); process.exit(1);
}
