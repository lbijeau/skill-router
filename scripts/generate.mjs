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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cmd = process.argv[2];
  if (cmd === "install" || cmd === "update" || cmd === "status") {
    console.error(`${cmd}: not implemented yet`); process.exit(1);
  }
  console.error("usage: generate.mjs <install|update|status>"); process.exit(1);
}
