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
      // Incremental: add extension.ts files if missing (for existing installations)
      const defaultsDir = path.join(__dirname, "defaults");
      const defaultToolsDir = path.join(defaultsDir, "tools");
      if (fs.existsSync(defaultToolsDir)) {
        for (const groupEntry of fs.readdirSync(defaultToolsDir, { withFileTypes: true })) {
          if (!groupEntry.isDirectory()) continue;
          const extSrc = path.join(defaultToolsDir, groupEntry.name, "extension.ts");
          const extDest = path.join(toolsConfigDir, groupEntry.name, "extension.ts");
          if (fs.existsSync(extSrc) && !fs.existsSync(extDest)) {
            fs.mkdirSync(path.join(toolsConfigDir, groupEntry.name), { recursive: true });
            fs.copyFileSync(extSrc, extDest);
          }
        }
      }
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
  fs.mkdirSync(path.join(dotBobbit, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(dotBobbit, "state", "session-prompts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dotBobbit, "state", "tls"), { recursive: true });

  // Copy default templates
  const defaultsDir = path.join(__dirname, "defaults");
  if (fs.existsSync(defaultsDir)) {
    copyDir(
      path.join(defaultsDir, "roles"),
      path.join(dotBobbit, "config", "roles"),
    );
    copyDir(
      path.join(defaultsDir, "workflows"),
      path.join(dotBobbit, "config", "workflows"),
    );
    copyDir(
      path.join(defaultsDir, "personalities"),
      path.join(dotBobbit, "config", "personalities"),
    );
    copyDir(
      path.join(defaultsDir, "tools"),
      path.join(dotBobbit, "config", "tools"),
    );
    const sysPromptSrc = path.join(defaultsDir, "system-prompt.md");
    if (fs.existsSync(sysPromptSrc)) {
      fs.copyFileSync(
        sysPromptSrc,
        path.join(dotBobbit, "config", "system-prompt.md"),
      );
    }
  }

  // Create .gitignore
  fs.writeFileSync(path.join(dotBobbit, ".gitignore"), "state/\n");

  console.log(
    `Created .bobbit/ in ${projectRoot}. Customize roles, workflows, and system prompt in .bobbit/config/`,
  );
}
