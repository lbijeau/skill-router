import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { NAME_RE, REPO_ROOT, ROUTER_AGENT_NAME, ROUTER_DESCRIPTION, STATE, atomicWrite, normalizeText, realPath, routerBodyLines, skillRows, tildePath, yamlQuote } from "./common.mjs";
import { discoverSkills } from "./discover.mjs";
import { claudeInstallStatus, claudeSkipReason, isOwnedClaudeAgent, pruneClaudeAgents, renderClaudeAgentFile, renderClaudeRouterAgent, resolveClaudeHome, runClaudeInstall, writeClaudeAgentFiles, writeClaudeRouterAgent } from "./claude.mjs";

export * from "./common.mjs";
export * from "./discover.mjs";
export * from "./claude.mjs";

const REQUIRED_FIELDS = ["url", "description", "persona"];

// Generous ceiling for a single git clone/pull: long enough for a slow link,
// short enough that a captive portal or dead remote doesn't hang install
// forever.
const GIT_TIMEOUT_MS = 300_000;

const URL_RE = /^(https:\/\/[\w.-]+(?:\/[\w._~-]+)+\/?|file:\/\/\/[\w.~\/-]+)$/;

// Per-repo trust decision for the generated pi/Vibe agents: "read-only"
// (default) gets the hardened allowlist below; "full" keeps today's
// full-tool-set behavior for personas whose skills genuinely edit files or run
// commands (see repos.json for which repos are marked "full" and why). This
// is a maintainer-reviewed, per-repo flag, not an automatic inference.
const TOOLS_POLICIES = new Set(["read-only", "full"]);

function validateManifestEntry(entry, seen) {
  if (typeof entry.name !== "string" || !NAME_RE.test(entry.name) || entry.name.length > 64) {
    throw new Error(`invalid name: ${JSON.stringify(entry?.name)}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      throw new Error(`${entry.name}: missing ${field}`);
    }
  }
  if (entry.tools !== undefined && !TOOLS_POLICIES.has(entry.tools)) {
    throw new Error(`${entry.name}: tools must be "read-only" or "full"`);
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
  for (const entry of parsed.repos) validateManifestEntry(entry, seen);
  const repos = [...parsed.repos];

  // repos.local.json is a gitignored overlay for machine-local repos (for
  // example a file:// clone that only exists on this disk). It must never be
  // folded into repos.json itself: that file is committed and shared, and a
  // local entry can carry a home-anchored path that would leak a username or
  // break install for anyone else who clones this repo. Overlay entries are
  // merged in after the committed ones, validated the same way (so a name
  // colliding with a committed entry is still a duplicate-name error), and
  // flagged `local: true` so generated-but-shared artifacts (the catalog) can
  // tell them apart from committed entries.
  const localFile = path.join(root, "repos.local.json");
  if (fs.existsSync(localFile)) {
    let localParsed;
    try {
      localParsed = JSON.parse(fs.readFileSync(localFile, "utf8"));
    } catch (e) {
      throw new Error(`cannot read manifest ${localFile}: ${e.message}`);
    }
    if (!Array.isArray(localParsed.repos)) {
      throw new Error("repos.local.json: repos must be an array");
    }
    for (const entry of localParsed.repos) {
      validateManifestEntry(entry, seen);
      repos.push({ ...entry, local: true });
    }
  }
  return { repos };
}

// pi's "tools:" frontmatter key is a strict child allowlist; omitting it gives
// the child pi's normal builtin tools, which per pi-subagents/docs/agents.md
// ("Tool and extension selection") and pi-coding-agent/docs/cli.md are
// read, bash, edit and write — full shell exec and file write, not a narrow
// read-only set. pi has no separate Glob tool: `find` is its glob-pattern
// path finder, so `read, grep, find, ls` is pi's closest equivalent to the
// Claude path's `Read, Grep, Glob` allowlist (verified against
// pi-subagents/docs/agents.md's own `tools: read, grep, find, ls` example and
// the scout builtin agent, and against pi-coding-agent/docs/cli.md's builtin
// tool table).
export const PI_READONLY_TOOLS_LINE = "tools: read, grep, find, ls";

export function renderAgentFile(entry, skillNames) {
  const toolsLine = entry.tools === "full" ? [] : [PI_READONLY_TOOLS_LINE];
  return [
    "---",
    `name: ${entry.name}`,
    `description: ${yamlQuote(entry.description)}`,
    "inheritSkills: false",
    ...toolsLine,
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

function tomlEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Vibe's "enabled_tools" is an explicit allowlist ("only these tools will be
// active", vibe/core/config/vibe_schema.py); without it an unannotated
// subagent gets the host's full default tool set (read_file, write_file,
// edit, bash/git_bash/powershell, grep, skill, ...) minus whatever
// disabled_tools removes — shell exec and file write included.
// `disabled_tools = ["skill"]` alone (today's clean room) only blocks the
// parent's skill-loading tool, not general capability. Vibe has no separate
// glob/find tool, so `read_file` + `grep` is its closest equivalent to the
// Claude path's `Read, Grep, Glob` allowlist — confirmed against the
// installed mistral_vibe package's own `explore` builtin subagent profile
// (vibe/core/agents/models.py: `enabled_tools: ["grep", "read_file",
// "skill"]`), minus "skill" per this project's clean room.
export const VIBE_READONLY_ENABLED_TOOLS = ["read_file", "grep"];

export function renderVibeAgentTOML(entry, skills, { home } = {}) {
  const homeDir = home ?? os.homedir();
  const description = tomlEscape(normalizeText(entry.description));
  const persona = tomlEscape(normalizeText(entry.persona, { keepNewlines: true }));
  const rows = skillRows(skills ?? [], homeDir, tomlEscape);
  const enabledToolsLine = entry.tools === "full"
    ? []
    : [`enabled_tools = [${VIBE_READONLY_ENABLED_TOOLS.map(t => `"${t}"`).join(", ")}]`];
  return [
    'agent_type = "subagent"',
    `description = "${description}"`,
    ...enabledToolsLine,
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
  return [
    "---",
    `name: ${ROUTER_AGENT_NAME}`,
    `description: ${yamlQuote(ROUTER_DESCRIPTION)}`,
    "inheritSkills: false",
    "---",
    ...routerBodyLines(root, home),
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
// It is itself committed and shared, so entries from the repos.local.json
// overlay (`entry.local`) are excluded — folding a machine-local repo in
// would make the committed catalog drift between machines. The tradeoff: a
// local-only repo still gets a local agent, but it is not routable via the
// catalog-driven router; the caller has to name its agent directly.
export function renderSkillCatalog(root, manifest, { home, skip } = {}) {
  const homeDir = home ?? os.homedir();
  const skipSet = skip ?? new Set();
  const parts = [
    "# Skill catalog",
    "",
    "Generated by scripts/generate.mjs from repos.json — do not edit.",
    "",
    "Skill names and one-line descriptions are quoted from each upstream repo's",
    "SKILL.md frontmatter. The upstream projects, their authors and their licenses",
    "are credited in [ATTRIBUTIONS.md](ATTRIBUTIONS.md); each upstream license",
    "governs its own material.",
    "",
  ];
  for (const entry of manifest.repos) {
    if (entry.local) continue;
    parts.push(`## ${entry.name}`, "");
    if (skipSet.has(entry.name)) {
      parts.push("(clone unavailable)", "");
      continue;
    }
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

export function writeSkillCatalog(root, manifest, skip = new Set()) {
  const content = renderSkillCatalog(root, manifest, { skip });
  let skillCount = 0;
  for (const entry of manifest.repos) {
    if (entry.local || skip.has(entry.name)) continue;
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
  const claudeAgents = pruneClaudeAgents(root, names);
  const skillsDir = path.join(root, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (d.isDirectory() && !names.has(d.name)) {
        fs.rmSync(path.join(skillsDir, d.name), { recursive: true, force: true });
        clones.push(d.name);
      }
    }
  }
  return { agents, clones, vibeAgents, claudeAgents };
}

function expandTilde(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function mergeSettings(settingsPath, repoRoot) {
  const home = os.homedir();
  const tmpRoot = realPath(os.tmpdir());
  const isTempPath = (p) => {
    try { return realPath(p).startsWith(tmpRoot + path.sep); }
    catch { return path.resolve(p).startsWith(tmpRoot + path.sep); }
  };
  // A settings file inside the temp dir is itself a test fixture; only persistent
  // user settings must never gain (or keep) temp-dir scan entries.
  const settingsArePersistent = !isTempPath(settingsPath);
  if (settingsArePersistent && isTempPath(path.join(repoRoot, "agents")))
    return { changed: false, entry: null, error: "refusing to register an agents dir under the system temp dir" };
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

  const rawList = Array.isArray(existing?.subagents?.agentScanDirs)
    ? existing.subagents.agentScanDirs : [];
  // Drop stale entries that live under the system temp dir (e.g. leaked test fixtures).
  const list = settingsArePersistent
    ? rawList.filter(d => !isTempPath(expandTilde(d)))
    : rawList;
  const already = list.some(d => realPath(expandTilde(d)) === realPath(resolved));
  if (already && list.length === rawList.length) return { changed: false, entry };

  atomicWrite(settingsPath + ".bak", fs.readFileSync(settingsPath, "utf8"));
  const nextList = already ? list : [...list, entry];
  const next = { ...existing,
    subagents: { ...existing?.subagents, agentScanDirs: nextList } };
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

// A generated file against what it should contain; `expected` is a thunk so the
// (sometimes expensive) render only runs when the file exists.
function fileState(file, expected) {
  if (!fs.existsSync(file)) return STATE.MISSING;
  return fs.readFileSync(file, "utf8") === expected() ? STATE.IN_SYNC : STATE.STALE;
}

// A per-repo output: a repo with no skills should have no file, and `absentLabel`
// is what that reads as (in-sync for pi, "—" for the optional targets).
function repoOutputState(file, skillCount, absentLabel, render) {
  if (skillCount === 0) return fs.existsSync(file) ? STATE.STALE : absentLabel;
  return fileState(file, render);
}

const isSettled = state => state === STATE.IN_SYNC || state === STATE.NONE;

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
    const n = found.skills.length;
    const agent = repoOutputState(path.join(root, "agents", `${entry.name}.md`), n, STATE.IN_SYNC,
      () => renderAgentFile(entry, found.skills.map(s => s.name)));
    const vibe = repoOutputState(path.join(root, "agents-vibe", `${entry.name}.toml`), n, STATE.NONE,
      () => renderVibeAgentTOML(entry, found.skills));
    const claudeFile = path.join(root, "agents-claude", `${entry.name}.md`);
    const claude = claudeSkipReason(entry)
      // The writer removes an owned leftover; one that is still there is stale.
      ? (entry.name !== ROUTER_AGENT_NAME && isOwnedClaudeAgent(claudeFile) ? STATE.STALE : STATE.NONE)
      : repoOutputState(claudeFile, n, STATE.NONE, () => renderClaudeAgentFile(entry, found.skills));
    rows.push({ name: entry.name, clone, skills: found.skills.length, agent, vibe, claude });
  }
  if (fs.existsSync(userAgentsDir)) {
    for (const r of rows) {
      if (fs.existsSync(path.join(userAgentsDir, `${r.name}.toml`))) {
        warnings.push(`${r.name}: name collision — also defined in ${userAgentsDir}`);
      }
    }
  }
  // Mirror runFlow's `failed` semantics: clones that are missing or not
  // repos render as (clone unavailable) in an install-written catalog, so the
  // expected catalog here must skip them too or a correct-but-partially-
  // failed install would read as stale forever.
  const catalogSkip = new Set(rows.filter(r => r.clone === "missing" || r.clone === "not-a-repo")
    .map(r => r.name));
  const catalog = fileState(path.join(root, "catalog", "skill-catalog.md"),
    () => renderSkillCatalog(root, manifest, { skip: catalogSkip }));
  const router = fileState(path.join(root, "agents", `${ROUTER_AGENT_NAME}.md`),
    () => renderRouterAgent({ root }));
  const claudeRouter = fileState(path.join(root, "agents-claude", `${ROUTER_AGENT_NAME}.md`),
    () => renderClaudeRouterAgent({ root }));
  let claudeInstall = STATE.NA;
  const claudeHome = opts.claudeHome;
  if (opts.claudeError) {
    warnings.push(`claude: ${opts.claudeError}`);
    claudeInstall = STATE.ERROR;
  }
  if (claudeHome && fs.existsSync(claudeHome)) {
    const r = claudeInstallStatus(root, claudeHome);
    claudeInstall = r.state;
    warnings.push(...r.warnings);
  }
  const ok = rows.every(r => r.clone === "ok" && r.agent === STATE.IN_SYNC
    && isSettled(r.vibe) && isSettled(r.claude)) && catalog === STATE.IN_SYNC
    && router === STATE.IN_SYNC && claudeRouter === STATE.IN_SYNC
    && (claudeInstall === STATE.NA || claudeInstall === STATE.IN_SYNC);
  return { rows, dropped, warnings, catalog, router, claudeRouter, claudeInstall, exitCode: ok ? 0 : 1 };
}

export function printStatus(root, manifest, opts = {}) {
  const { rows, dropped, warnings, catalog, router, claudeRouter, claudeInstall, exitCode } = statusOf(root, manifest, opts);
  // NAME column width tracks the longest name in play, with a 2-space gap, so
  // a name as long as the old constant (e.g. "security-audit") doesn't glue
  // straight into the next column.
  const nameWidth = Math.max("NAME".length, ...rows.map(r => r.name.length)) + 2;
  const otherWidths = [10, 7, 10, 10, 10];
  const lines = [
    ["NAME", "CLONE", "SKILLS", "AGENT", "VIBE", "CLAUDE"].reduce((a, h, i) => a + h.padEnd(i === 0 ? nameWidth : otherWidths[i - 1]), "") + "CATALOG    ROUTER",
    " ".repeat(nameWidth + otherWidths.reduce((a, b) => a + b, 0)) + catalog.padEnd(10) + router,
  ];
  for (const r of rows) {
    lines.push(r.name.padEnd(nameWidth) + r.clone.padEnd(10) + String(r.skills).padEnd(7)
      + r.agent.padEnd(10) + r.vibe.padEnd(10) + r.claude);
  }
  lines.push(`claude install: ${claudeInstall}`);
  if (claudeRouter !== "in-sync") lines.push(`claude router: ${claudeRouter}`);
  lines.push(...dropped, ...warnings);
  return { output: lines.join("\n") + "\n", exitCode };
}

function runFlow(root, mode, { settingsPath, vibeConfigPath, skillsHome, claudeHome, gitTimeoutMs = GIT_TIMEOUT_MS }) {
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
      const r = spawnSync("git", ["clone", "--depth", "1", entry.url, cloneDir], { encoding: "utf8", timeout: gitTimeoutMs });
      if (r.status !== 0) {
        const last = r.error?.code === "ETIMEDOUT"
          ? `timed out after ${gitTimeoutMs / 1000}s`
          : (r.stderr || "git clone failed").trim().split("\n").pop();
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
          const p = spawnSync("git", ["-C", cloneDir, "pull", "--ff-only"], { encoding: "utf8", timeout: gitTimeoutMs });
          if (p.status !== 0) {
            const reason = p.error?.code === "ETIMEDOUT"
              ? `timed out after ${gitTimeoutMs / 1000}s`
              : "left as-is";
            report.push(`${entry.name}: pull failed (${reason})`);
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
  // Overlay entries generate agent files into the committed agents/ dirs so pi
  // can discover them; those files are machine-local, so warn loudly — nothing
  // guards them against an accidental `git add -A` except this line and README.
  for (const entry of manifest.repos) {
    if (entry.local && !failed.has(entry.name))
      report.push(`${entry.name}: local overlay entry — generated agent files are machine-local, do not commit them`);
  }
  const vibeResult = writeVibeAgentFiles(root, manifest, failed);
  for (const name of vibeResult.removed) {
    report.push(`${name}: 0 skills, removed stale vibe agent`);
  }
  const claudeResult = writeClaudeAgentFiles(root, manifest, failed);
  for (const warn of claudeResult.warnings) report.push(warn);
  for (const name of claudeResult.removed) {
    report.push(`${name}: 0 skills, removed stale claude agent`);
  }
  const catalogResult = writeSkillCatalog(root, manifest, failed);
  report.push(`catalog: ${catalogResult.skillCount} skills written to catalog/skill-catalog.md`);
  writeRouterAgent(root);
  report.push(`router agent: ${ROUTER_AGENT_NAME} written to agents/${ROUTER_AGENT_NAME}.md`);
  writeClaudeRouterAgent(root);
  report.push(`claude router agent: ${ROUTER_AGENT_NAME} written to agents-claude/${ROUTER_AGENT_NAME}.md`);
  const synced = syncGlobalSkills(root, skillsHome);
  for (const f of synced.written) {
    report.push(`global skill: ${path.basename(path.dirname(f))} synced to ${tildePath(f)}`);
  }
  const piWritten = new Set(genResult.written);
  const vibeWritten = new Set(vibeResult.written);
  const claudeWritten = new Set(claudeResult.written);
  for (const { entry, state } of states) {
    const found = discoverSkills(path.join(root, "skills", entry.name), entry);
    const names = found.skills.map(s => s.name);
    const targets = [];
    if (piWritten.has(entry.name)) targets.push("pi");
    if (vibeWritten.has(entry.name)) targets.push("vibe");
    if (claudeWritten.has(entry.name)) targets.push("claude");
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
  for (const c of pruned.claudeAgents) report.push(`pruned ${c} (claude agent)`);
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
  if (claudeHome != null) runClaudeInstall(root, claudeHome, report);
  report.push("reminder: run /reload (or restart Vibe) to pick up new agents");
  report.push("reminder: enabled_agents / disabled_agents config filters override agent discovery");
  return { exitCode: anyFailed ? 1 : 0, report };
}

const DEFAULT_SETTINGS = () => path.join(os.homedir(), ".pi/agent/settings.json");

const DEFAULT_VIBE_CONFIG = () => path.join(process.env.VIBE_HOME || path.join(os.homedir(), ".vibe"), "config.toml");

// `paths` = { settingsPath, vibeConfigPath, skillsHome, claudeHome }. The first
// two default to the real pi and Vibe config; `skillsHome` defaults to the pi
// skills dir; `claudeHome` null/undefined skips the Claude install step
// (generation of agents-claude/ still runs). Only the CLI computes a Claude default.
function flowPaths(paths) {
  if (paths === null || typeof paths !== "object" || Array.isArray(paths)) {
    throw new TypeError("runInstall/runUpdate take (root, { settingsPath, vibeConfigPath, skillsHome, claudeHome })");
  }
  return { ...paths,
    settingsPath: paths.settingsPath ?? DEFAULT_SETTINGS(),
    vibeConfigPath: paths.vibeConfigPath ?? DEFAULT_VIBE_CONFIG() };
}

export function runInstall(root, paths = {}) { return runFlow(root, "install", flowPaths(paths)); }

export function runUpdate(root, paths = {}) { return runFlow(root, "update", flowPaths(paths)); }

// The CLI as a function so it can be tested against a temp root and temp config
// paths; `opts` = { root, home, settingsPath, vibeConfigPath, skillsHome }.
export function runCli(argv, env, opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const cmd = argv[0];
  const out = [], err = [];
  let claudeHome = null;
  let claudeError = null;
  const noClaude = argv.includes("--no-claude");
  if (!noClaude) {
    const c = resolveClaudeHome(env, opts.home ?? os.homedir());
    if (c.error) claudeError = c.error;
    else claudeHome = c.dir;
  }
  try {
    if (cmd === "status") {
      const st = printStatus(root, loadManifest(root), { claudeHome, claudeError });
      out.push(st.output.trimEnd());
      return { exitCode: st.exitCode, out, err };
    }
    if (cmd === "install" || cmd === "update") {
      // A custom root (tests) must not fall back to the real pi, Vibe or Claude config.
      const claudeTargetKnown = Boolean(opts.home) || noClaude || Boolean(env.CLAUDE_CONFIG_DIR);
      if (opts.root && !(opts.settingsPath && opts.vibeConfigPath && opts.skillsHome && claudeTargetKnown)) {
        err.push("runCli: a custom root needs explicit settingsPath, vibeConfigPath and skillsHome, and a home, CLAUDE_CONFIG_DIR or --no-claude (it would otherwise write the real pi, Vibe and Claude config)");
        return { exitCode: 1, out, err };
      }
      const run = cmd === "install" ? runInstall : runUpdate;
      const r = run(root, { settingsPath: opts.settingsPath, vibeConfigPath: opts.vibeConfigPath,
        skillsHome: opts.skillsHome, claudeHome });
      if (noClaude) out.push("claude: skipped (--no-claude)");
      out.push(...r.report);
      if (claudeError) {
        out.push(`claude: skipped (${claudeError})`);
        return { exitCode: 1, out, err };
      }
      return { exitCode: r.exitCode, out, err };
    }
  } catch (e) {
    err.push(e.message);
    return { exitCode: 1, out, err };
  }
  err.push("usage: generate.mjs <install|update|status> [--no-claude]");
  return { exitCode: 1, out, err };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = runCli(process.argv.slice(2), process.env);
  for (const line of r.out) console.log(line);
  for (const line of r.err) console.error(line);
  process.exit(r.exitCode);
}
