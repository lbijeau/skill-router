import fs from "node:fs";
import path from "node:path";
import { NAME_RE, normalizeText } from "./common.mjs";

// Read repos.json directly (not via generate.mjs's loadManifest — Task 2 makes
// generate.mjs import this module, and importing back would create an ESM
// cycle). Only the entry `name` fields matter here; full manifest validation is
// loadManifest's job.
function repoNames(root) {
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
  return new Set(parsed.repos.map((entry) => entry?.name));
}

function validateOutput(output, name, i) {
  if (typeof output !== "string" || output === "") {
    throw new Error(`workflow "${name}": step ${i + 1} has an invalid output path`);
  }
  if (output.includes("\\")) {
    throw new Error(`workflow "${name}": step ${i + 1} output "${output}" must not contain backslashes`);
  }
  if (path.isAbsolute(output)) {
    throw new Error(`workflow "${name}": step ${i + 1} output "${output}" must be a relative path`);
  }
  const normalized = path.normalize(output);
  if (path.isAbsolute(normalized) || normalized.split(path.sep).includes("..")) {
    throw new Error(`workflow "${name}": step ${i + 1} output "${output}" escapes the project`);
  }
  return normalized;
}

export function loadWorkflows(root) {
  const file = path.join(root, "workflows.json");
  if (!fs.existsSync(file)) return { workflows: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read workflows ${file}: ${e.message}`);
  }
  if (!Array.isArray(parsed.workflows)) {
    throw new Error("workflows.json: workflows must be an array");
  }
  const agents = repoNames(root);
  const seenNames = new Set();
  const workflows = parsed.workflows.map((entry) => {
    const name = entry?.name;
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw new Error(`workflows.json: invalid workflow name ${JSON.stringify(name)}`);
    }
    if (seenNames.has(name)) {
      throw new Error(`workflow "${name}": duplicate workflow name`);
    }
    seenNames.add(name);
    const description = normalizeText(entry.description ?? "");
    if (!description) {
      throw new Error(`workflow "${name}": description must not be empty`);
    }
    if (!Array.isArray(entry.steps)) {
      throw new Error(`workflow "${name}": steps must be an array`);
    }
    if (entry.steps.length === 0) {
      throw new Error(`workflow "${name}": steps must not be empty`);
    }
    const seenOutputs = new Set();
    const steps = entry.steps.map((step, i) => {
      if (!agents.has(step?.agent)) {
        throw new Error(`workflow "${name}": step ${i + 1} references unknown agent "${step?.agent}"`);
      }
      const task = normalizeText(step.task ?? "");
      if (!task) {
        throw new Error(`workflow "${name}": step ${i + 1} task must not be empty`);
      }
      const output = validateOutput(step.output, name, i);
      if (seenOutputs.has(output)) {
        throw new Error(`workflow "${name}": step ${i + 1} repeats output path "${output}"`);
      }
      seenOutputs.add(output);
      return { agent: step.agent, task, output };
    });
    return { name, description, steps };
  });
  return { workflows };
}
