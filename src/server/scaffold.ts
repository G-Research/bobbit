import fs from "node:fs";
import path from "node:path";
import { headquartersDir, normalProjectBobbitDir } from "./bobbit-dir.js";

const BOBBIT_GITIGNORE_PATTERNS = ["headquarters/", "state/", "agent/"];

function ensureBobbitGitignore(dotBobbit: string): void {
  fs.mkdirSync(dotBobbit, { recursive: true });
  const gitignorePath = path.join(dotBobbit, ".gitignore");
  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf-8");
  }

  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const additions = BOBBIT_GITIGNORE_PATTERNS.filter((pattern) => !lines.includes(pattern) && !lines.includes(`/${pattern}`));
  if (additions.length === 0) return;

  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${content}${prefix}${additions.join("\n")}\n`);
}

/**
 * Scaffold the Headquarters/server Bobbit directory structure.
 * Normal project `.bobbit/{state,config}` is created by project registration;
 * this startup scaffold must not treat `<serverRunDir>/.bobbit/config` as
 * Headquarters config because that path can belong to a same-root normal project.
 *
 * Tool groups, roles, and the system prompt are NOT copied from defaults — they
 * resolve at runtime via the config cascade from `dist/server/defaults/`. Only
 * user-customised files should exist in `<headquartersDir>/config/`. Users opt
 * in to customisation explicitly (see `POST /api/system-prompt/customise`);
 * shipped defaults therefore auto-upgrade with each Bobbit release.
 */
export function scaffoldBobbitDir(projectRoot: string): void {
  const serverDotBobbit = normalProjectBobbitDir(projectRoot);
  const dotBobbit = headquartersDir(projectRoot);
  const configDir = path.join(dotBobbit, "config");

  // The default layout nests Headquarters under <serverRunDir>/.bobbit/, so keep
  // that owner directory safe even when it also stores a normal same-root project.
  const defaultHeadquartersDir = path.join(serverDotBobbit, "headquarters");
  if (path.resolve(dotBobbit) === path.resolve(defaultHeadquartersDir) || fs.existsSync(serverDotBobbit)) {
    ensureBobbitGitignore(serverDotBobbit);
  }
  if (path.resolve(dotBobbit) !== path.resolve(serverDotBobbit)) {
    ensureBobbitGitignore(dotBobbit);
  }

  if (fs.existsSync(configDir)) {
    // Existing Headquarters installation — no incremental tool copying.
    // Tools now resolve via the config cascade from builtins.
    const toolsConfigDir = path.join(configDir, "tools");
    if (!fs.existsSync(toolsConfigDir)) {
      fs.mkdirSync(toolsConfigDir, { recursive: true });
    }
    fs.mkdirSync(path.join(dotBobbit, "state", "session-prompts"), { recursive: true });
    fs.mkdirSync(path.join(dotBobbit, "extensions"), { recursive: true });
    return;
  }

  console.log(`Creating Headquarters .bobbit/ in ${dotBobbit}...`);

  // Create Headquarters directory structure.
  fs.mkdirSync(path.join(configDir, "roles"), { recursive: true });
  // Workflows are no longer scaffolded as a runtime directory — they live
  // inline in `project.yaml::workflows`. New projects start with no workflows;
  // the project assistant generates them on registration.
  // Create empty tools directory — tool groups resolve via cascade from builtins.
  fs.mkdirSync(path.join(configDir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(dotBobbit, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(dotBobbit, "state", "session-prompts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dotBobbit, "state", "tls"), { recursive: true });

  console.log(
    `Created Headquarters .bobbit/ in ${dotBobbit}. Customize roles, workflows, and system prompt in its config/ directory`,
  );
}
