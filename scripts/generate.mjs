import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REQUIRED_FIELDS = ["url", "description", "persona"];

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
    if (seen.has(entry.name)) {
      throw new Error(`duplicate name: ${entry.name}`);
    }
    seen.add(entry.name);
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
  if (fs.existsSync(path.join(dir, "SKILL.md"))) out.push(dir);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  const children = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(n => !n.startsWith(".") && !SKIP_DIRS.has(n))
    .sort();
  for (const n of children) walkSkillDirs(path.join(dir, n), out);
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
    const lines = content.replace(/^\uFEFF/, "").split("\n");
    if (lines[0].trimEnd() !== "---") {
      warnings.push(`malformed frontmatter in ${file}: no opening ---`);
      continue;
    }
    let name = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      if (line === "---") break;
      const m = line.match(/^name:[ \t]*(.*?)[ \t]*$/);
      if (m) { name = m[1]; break; }
    }
    if (name === null || name === "") name = path.basename(dir);
    if (/[,:"]/.test(name) || name.trim() !== name) {
      warnings.push(`unexpressible skill name: ${JSON.stringify(name)} in ${dir}`);
      continue;
    }
    const existing = byName.get(name);
    if (existing) {
      dropped.push({ name, keptDir: existing.dir, droppedDir: dir });
    } else {
      const ref = { name, dir };
      byName.set(name, ref);
      skills.push(ref);
    }
  }
  return { skills, dropped, warnings };
}

export function renderAgentFile(entry, skillNames) {
  const description = entry.description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

export function writeAgentFiles(root, manifest) {
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const written = [], removed = [], warnings = [];
  for (const entry of manifest.repos) {
    const found = discoverSkills(path.join(root, "skills", entry.name), entry);
    warnings.push(...found.warnings);
    const file = path.join(agentsDir, `${entry.name}.md`);
    if (found.skills.length > 0) {
      fs.writeFileSync(file, renderAgentFile(entry, found.skills.map(s => s.name)));
      written.push(entry.name);
    } else if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed.push(entry.name);
    }
  }
  return { written, removed, warnings };
}

export function prune(root, manifest) {
  const agents = [], clones = [];
  const names = new Set(manifest.repos.map(e => e.name));
  const agentsDir = path.join(root, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir)) {
      const m = f.match(/^(.*)\.md$/);
      if (m && !names.has(m[1])) {
        fs.rmSync(path.join(agentsDir, f));
        agents.push(m[1]);
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
  return { agents, clones };
}

function expandTilde(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function mergeSettings(settingsPath, repoRoot) {
  const home = os.homedir();
  const underHome = repoRoot === home || repoRoot.startsWith(home + path.sep);
  const entry = underHome
    ? "~/" + path.relative(home, repoRoot) + "/agents"
    : path.join(repoRoot, "agents");
  const resolved = path.resolve(repoRoot, "agents");

  let existing = null;
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
    catch { return { changed: false, entry, error: "unparseable settings file, merge skipped" }; }
  }

  if (existing === null) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath,
      JSON.stringify({ subagents: { agentScanDirs: [entry] } }, null, 2) + "\n");
    return { changed: true, entry };
  }

  const list = Array.isArray(existing?.subagents?.agentScanDirs)
    ? existing.subagents.agentScanDirs : [];
  const already = list.some(d => path.resolve(expandTilde(d)) === resolved);
  if (already) return { changed: false, entry };

  fs.copyFileSync(settingsPath, settingsPath + ".bak");
  const next = { ...existing,
    subagents: { ...existing.subagents, agentScanDirs: [...list, entry] } };
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n");
  return { changed: true, entry };
}

export function cloneState(cloneDir) {
  if (!fs.existsSync(cloneDir)) return "missing";
  if (!fs.existsSync(path.join(cloneDir, ".git"))) return "not-a-repo";
  const st = spawnSync("git", ["-C", cloneDir, "status", "--porcelain"], { encoding: "utf8" });
  if (st.status !== 0) return "not-a-repo";
  return st.stdout.trim() === "" ? "ok" : "dirty";
}

export function statusOf(root, manifest) {
  const rows = [];
  for (const entry of manifest.repos) {
    const cloneDir = path.join(root, "skills", entry.name);
    const clone = cloneState(cloneDir);
    const found = discoverSkills(cloneDir, entry);
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
    rows.push({ name: entry.name, clone, skills: found.skills.length, agent });
  }
  const ok = rows.every(r => r.clone === "ok" && r.agent === "in-sync");
  return { rows, exitCode: ok ? 0 : 1 };
}

function printStatus(root, manifest) {
  const { rows, exitCode } = statusOf(root, manifest);
  console.log(["NAME", "CLONE", "SKILLS", "AGENT"].reduce((a, h, i) => a + h.padEnd([14, 10, 7, 10][i]), ""));
  for (const r of rows) {
    console.log(r.name.padEnd(14) + r.clone.padEnd(10) + String(r.skills).padEnd(7) + r.agent);
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cmd = process.argv[2];
  if (cmd === "status") {
    try { process.exit(printStatus(REPO_ROOT, loadManifest(REPO_ROOT))); }
    catch (e) { console.error(e.message); process.exit(1); }
  }
  if (cmd === "install" || cmd === "update") {
    console.error(`${cmd}: not implemented yet`); process.exit(1);
  }
  console.error("usage: generate.mjs <install|update|status>"); process.exit(1);
}
