import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitDir } from "./bobbit-dir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Scaffold the .bobbit directory structure in the project root.
 * Only runs if .bobbit/ doesn't already exist — never overwrites user config.
 *
 * Tool groups are NOT copied from defaults — they resolve at runtime via the
 * config cascade from dist/server/defaults/tools/. Only user-customized groups
 * should exist in .bobbit/config/tools/.
 */
export function scaffoldBobbitDir(projectRoot: string): void {
  const dotBobbit = bobbitDir(projectRoot);

  // Check for config/ subdir to determine if already scaffolded.
  // The top-level dir may already exist (e.g. created by env var or mkdir).
  if (fs.existsSync(path.join(dotBobbit, "config"))) {
    // Existing installation — no incremental tool copying.
    // Tools now resolve via the config cascade from builtins.
    // Note: roles/assistant/ sub-prompts are no longer scaffolded here — they
    // resolve at runtime via the config cascade from dist/server/defaults/.

    // Ensure the tools directory exists (may be missing if this is an
    // existing installation that never had tools overrides)
    const toolsConfigDir = path.join(dotBobbit, "config", "tools");
    if (!fs.existsSync(toolsConfigDir)) {
      fs.mkdirSync(toolsConfigDir, { recursive: true });
    }

    return;
  }

  console.log(`Creating .bobbit/ in ${projectRoot}...`);

  // Create directory structure
  fs.mkdirSync(path.join(dotBobbit, "config", "roles"), { recursive: true });
  fs.mkdirSync(path.join(dotBobbit, "config", "workflows"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dotBobbit, "config", "personalities"), {
    recursive: true,
  });
  // Create empty tools directory — tool groups resolve via cascade from builtins
  fs.mkdirSync(path.join(dotBobbit, "config", "tools"), { recursive: true });
  fs.mkdirSync(path.join(dotBobbit, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(dotBobbit, "state", "session-prompts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dotBobbit, "state", "tls"), { recursive: true });

  // Roles, workflows, personalities, and tools are resolved at runtime via ConfigCascade
  // (seeded from builtins on startup). Only create empty directories for them.
  const defaultsDir = path.join(__dirname, "defaults");
  if (fs.existsSync(defaultsDir)) {
    const sysPromptSrc = path.join(defaultsDir, "system-prompt.md");
    if (fs.existsSync(sysPromptSrc)) {
      fs.copyFileSync(
        sysPromptSrc,
        path.join(dotBobbit, "config", "system-prompt.md"),
      );
    }
    // Tool groups are NOT copied — they resolve via cascade from builtins
  }

  // Create .gitignore
  fs.writeFileSync(path.join(dotBobbit, ".gitignore"), "state/\n");

  console.log(
    `Created .bobbit/ in ${projectRoot}. Customize roles, workflows, and system prompt in .bobbit/config/`,
  );
}
