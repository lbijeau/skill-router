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
    let closed = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      if (line === "---") { closed = true; break; }
      const m = line.match(/^name:[ \t]*(.*?)[ \t]*$/);
      if (m) name = m[1];
    }
    if (!closed) {
      warnings.push(`malformed frontmatter in ${file}: no closing ---`);
      continue;
    }
    if (name === null || name === "") name = path.basename(dir);
    if (!NAME_RE.test(name) || name.length > 64) {
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

export function prune(root, manifest) {
  const agents = [], clones = [];
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

export function cloneState(cloneDir) {
  if (!fs.existsSync(cloneDir)) return "missing";
  if (!fs.existsSync(path.join(cloneDir, ".git"))) return "not-a-repo";
  const st = spawnSync("git", ["-C", cloneDir, "status", "--porcelain"], { encoding: "utf8" });
  if (st.status !== 0) return "not-a-repo";
  return st.stdout.trim() === "" ? "ok" : "dirty";
}

export function statusOf(root, manifest) {
  const rows = [];
  const dropped = [];
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
    rows.push({ name: entry.name, clone, skills: found.skills.length, agent });
  }
  const ok = rows.every(r => r.clone === "ok" && r.agent === "in-sync");
  return { rows, dropped, exitCode: ok ? 0 : 1 };
}

function printStatus(root, manifest) {
  const { rows, dropped, exitCode } = statusOf(root, manifest);
  console.log(["NAME", "CLONE", "SKILLS", "AGENT"].reduce((a, h, i) => a + h.padEnd([14, 10, 7, 10][i]), ""));
  for (const r of rows) {
    console.log(r.name.padEnd(14) + r.clone.padEnd(10) + String(r.skills).padEnd(7) + r.agent);
  }
  for (const d of dropped) console.log(d);
  return exitCode;
}

function runFlow(root, settingsPath, mode) {
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
  for (const { entry, state } of states) {
    const found = discoverSkills(path.join(root, "skills", entry.name), entry);
    const names = found.skills.map(s => s.name);
    report.push(`${entry.name}: ${state}, ${found.skills.length} skills, ` +
      (found.skills.length ? "agent written" : "no agent"));
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
  for (const c of pruned.clones) report.push(`pruned ${c} (clone)`);
  const settings = mergeSettings(settingsPath, root);
  if (settings.error) {
    report.push(`settings: skipped (${settings.error})`);
  } else {
    report.push(settings.changed
      ? `settings: added ${settings.entry}`
      : `settings: already configured (${settings.entry})`);
  }
  return { exitCode: anyFailed ? 1 : 0, report };
}

const DEFAULT_SETTINGS = () => path.join(os.homedir(), ".pi/agent/settings.json");
export function runInstall(root, settingsPath) {
  return runFlow(root, settingsPath ?? DEFAULT_SETTINGS(), "install");
}
export function runUpdate(root, settingsPath) {
  return runFlow(root, settingsPath ?? DEFAULT_SETTINGS(), "update");
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
