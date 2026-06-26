import fs from "node:fs";
import path from "node:path";
import { bobbitDir } from "./bobbit-dir.js";

const BOBBIT_GITIGNORE_PATTERNS = ["state/", "agent/"];

function ensureBobbitGitignore(dotBobbit: string): void {
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
 * Scaffold the .bobbit directory structure in the project root.
 * Only runs if .bobbit/ doesn't already exist — never overwrites user config.
 *
 * Tool groups, roles, and the system prompt are NOT copied from defaults — they
 * resolve at runtime via the config cascade from `dist/server/defaults/`. Only
 * user-customised files should exist in `.bobbit/config/`. Users opt in to
 * customisation explicitly (see `POST /api/system-prompt/customise`); shipped
 * defaults therefore auto-upgrade with each Bobbit release.
 */
export function scaffoldBobbitDir(projectRoot: string): void {
  const dotBobbit = bobbitDir(projectRoot);

  // Check for config/ subdir to determine if already scaffolded.
  // The top-level dir may already exist (e.g. created by env var or mkdir).
  if (fs.existsSync(path.join(dotBobbit, "config"))) {
    // Existing installation — no incremental tool copying.
    // Tools now resolve via the config cascade from builtins.

    // Ensure the tools directory exists (may be missing if this is an
    // existing installation that never had tools overrides)
    const toolsConfigDir = path.join(dotBobbit, "config", "tools");
    if (!fs.existsSync(toolsConfigDir)) {
      fs.mkdirSync(toolsConfigDir, { recursive: true });
    }
    ensureBobbitGitignore(dotBobbit);

    return;
  }

  console.log(`Creating .bobbit/ in ${projectRoot}...`);

  // Create directory structure
  fs.mkdirSync(path.join(dotBobbit, "config", "roles"), { recursive: true });
  // Workflows are no longer scaffolded as a runtime directory — they live
  // inline in `project.yaml::workflows`. New projects start with no workflows;
  // the project assistant generates them on registration.
  // Create empty tools directory — tool groups resolve via cascade from builtins
  fs.mkdirSync(path.join(dotBobbit, "config", "tools"), { recursive: true });
  fs.mkdirSync(path.join(dotBobbit, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(dotBobbit, "state", "session-prompts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dotBobbit, "state", "tls"), { recursive: true });

  // Create .gitignore
  ensureBobbitGitignore(dotBobbit);

  console.log(
    `Created .bobbit/ in ${projectRoot}. Customize roles, workflows, and system prompt in .bobbit/config/`,
  );
}
