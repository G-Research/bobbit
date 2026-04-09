import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitDir } from "./bobbit-dir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Recursively copy all files from src to dest directory. */
function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Scaffold the .bobbit directory structure in the project root.
 * Only runs if .bobbit/ doesn't already exist — never overwrites user config.
 */
export function scaffoldBobbitDir(projectRoot: string): void {
  const dotBobbit = bobbitDir(projectRoot);

  // Check for config/ subdir to determine if already scaffolded.
  // The top-level dir may already exist (e.g. created by env var or mkdir).
  if (fs.existsSync(path.join(dotBobbit, "config"))) {
    // Incremental scaffolding: add tools/ if missing (for existing installations)
    const toolsConfigDir = path.join(dotBobbit, "config", "tools");
    if (!fs.existsSync(toolsConfigDir)) {
      const defaultsDir = path.join(__dirname, "defaults");
      const defaultToolsDir = path.join(defaultsDir, "tools");
      if (fs.existsSync(defaultToolsDir)) {
        console.log(`Adding .bobbit/config/tools/ to existing installation...`);
        copyDir(defaultToolsDir, toolsConfigDir);
      }
    } else {
      // Incremental: add new tool groups and missing extension.ts files (for existing installations)
      const defaultsDir = path.join(__dirname, "defaults");
      const defaultToolsDir = path.join(defaultsDir, "tools");
      if (fs.existsSync(defaultToolsDir)) {
        for (const groupEntry of fs.readdirSync(defaultToolsDir, { withFileTypes: true })) {
          if (!groupEntry.isDirectory()) continue;
          const groupDest = path.join(toolsConfigDir, groupEntry.name);
          if (!fs.existsSync(groupDest)) {
            // New tool group — copy entire directory
            copyDir(path.join(defaultToolsDir, groupEntry.name), groupDest);
          } else {
            // Existing group — add missing extension.ts only
            const extSrc = path.join(defaultToolsDir, groupEntry.name, "extension.ts");
            const extDest = path.join(groupDest, "extension.ts");
            if (fs.existsSync(extSrc) && !fs.existsSync(extDest)) {
              fs.copyFileSync(extSrc, extDest);
            }
          }
        }
      }
    }
    // Note: roles/assistant/ sub-prompts are no longer scaffolded here — they
    // resolve at runtime via the config cascade from dist/server/defaults/.

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
  fs.mkdirSync(path.join(dotBobbit, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(dotBobbit, "state", "session-prompts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dotBobbit, "state", "tls"), { recursive: true });

  // Roles, workflows, and personalities are resolved at runtime via ConfigCascade
  // (seeded from builtins on startup). Only create empty directories for them.
  // Tools are copied from defaults because they contain YAML files with provider
  // configs and extension code that updateToolMetadata() modifies in-place.
  const defaultsDir = path.join(__dirname, "defaults");
  if (fs.existsSync(defaultsDir)) {
    const sysPromptSrc = path.join(defaultsDir, "system-prompt.md");
    if (fs.existsSync(sysPromptSrc)) {
      fs.copyFileSync(
        sysPromptSrc,
        path.join(dotBobbit, "config", "system-prompt.md"),
      );
    }
    // Copy tool YAML files (needed for in-place metadata updates)
    const defaultToolsDir = path.join(defaultsDir, "tools");
    if (fs.existsSync(defaultToolsDir)) {
      copyDir(defaultToolsDir, path.join(dotBobbit, "config", "tools"));
    }
  }

  // Create .gitignore
  fs.writeFileSync(path.join(dotBobbit, ".gitignore"), "state/\n");

  console.log(
    `Created .bobbit/ in ${projectRoot}. Customize roles, workflows, and system prompt in .bobbit/config/`,
  );
}
