#!/usr/bin/env node
/**
 * Migration script: Split tool docs into lean `docs` (prompt-injected) and `detail_docs` (on-demand).
 * 
 * For each tool YAML:
 * 1. Move current `docs` → `detail_docs`
 * 2. Set `docs` to a lean version (params + critical gotchas only)
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const TOOLS_DIR = path.join(process.cwd(), '.bobbit', 'config', 'tools');

// Lean docs for each tool — only what the model can't infer from name + summary + schema
const LEAN_DOCS = {
  // Agent
  delegate: `Instructions must be self-contained — delegate has NO conversation context. Use \`parallel\` array for concurrent execution. 10min default timeout. Never delegate just to read files — use parallel \`read\` calls instead. Each delegate spawns an entire agent process (significant overhead).`,

  // Browser
  browser_click: `Use \`browser_wait\` first for dynamic elements. First match in DOM order is clicked. Element must be visible and clickable.`,
  browser_eval: `Return objects via \`JSON.stringify()\`. Supports \`await\`. Runs in page context (browser APIs, not Node.js). Side effects persist until next navigation.`,
  browser_navigate: `Launches browser if needed. Session persists (cookies, localStorage). Prefer \`web_fetch\` for static pages (10x faster). Waits for DOMContentLoaded only — use \`browser_wait\` for async content.`,
  browser_screenshot: `Viewport only by default; use \`fullPage: true\` for full scrollable page. Use \`selector\` to capture a specific element. Returns image inline in chat.`,
  browser_type: `Clears field before typing by default. Set \`clear: false\` to append (types char-by-char via pressSequentially). Fires input/change/key events. Target must be input, textarea, or contenteditable.`,
  browser_wait: `Timeout in **milliseconds** (default 10000 — not seconds). Waits for **visibility**, not just DOM presence. Use before \`browser_click\` on dynamic content. Throws on timeout.`,

  // Filesystem
  edit: `\`oldText\` must match **exactly** — whitespace, indentation, newlines. Always \`read\` first to get exact text. First occurrence only; include surrounding context to disambiguate. Empty \`newText\` deletes the matched text.`,
  find: `All paths must use forward slashes, even on Windows. Respects .gitignore. Returns paths relative to search directory.`,
  grep: `All paths must use forward slashes. Respects .gitignore. Output truncated to 100 matches / 50KB. **Cannot search patterns starting with \`--\`** — use \`bash\` with \`rg -- 'pattern'\` instead.`,
  ls: `All paths must use forward slashes. Directories suffixed with \`/\`. Includes dotfiles. Truncated to 500 entries.`,
  read: `Truncated to 2000 lines / 50KB — use \`offset\`/\`limit\` for large files. Offset is 1-indexed. Supports images (jpg, png, gif, webp) as visual attachments. Launch parallel \`read\` calls for multiple files.`,
  write: `**Overwrites entirely** — use \`edit\` for surgical changes to existing files. Creates parent directories automatically. \`.html\`/\`.svg\` files render inline in chat. No append mode — read first, then write combined content.`,

  // Shell
  bash: `Output truncated to last 2000 lines / 50KB. **Never start background processes** (\`node server.js &\`, \`nohup\`) — stdout/stderr pipes stay open and hang the agent session forever. Use \`bash_bg\` instead. Exit code reported alongside output. Use \`--\` before rg/grep patterns starting with \`--\`.`,
  bash_bg: `Actions: create (start a process), logs (view output), kill (terminate), list (show all). Use for dev servers, file watchers, long-running builds. Parameters: \`command\` (for create), \`id\` (for logs/kill), \`tail\` (log lines, default 200).`,

  // Gates
  gate_list: `No parameters. Returns all workflow gates with status (\`pending\`/\`passed\`/\`failed\`), dependencies, and content flags. Call at start of work to understand workflow state.`,
  gate_signal: `Triggers async verification after signaling. Server enforces dependency ordering — upstream gates must pass first (409 if not). Include \`content\` (markdown) for content gates like design docs.`,
  gate_status: `Returns single gate's full detail including content body, signal history, and verification results. Use for reading upstream gate content (e.g. design docs).`,

  // Tasks
  task_create: `Server enforces upstream gate dependencies (409 Conflict if unmet). Tasks start as \`todo\`. \`type\` is one of: implementation, code-review, testing, bug-fix, refactor, custom. Use \`depends_on\` for explicit ordering.`,
  task_list: `No parameters. Returns all tasks for the current goal with state, assignments, and dependencies.`,
  task_update: `Transition task state: \`todo\` → \`in-progress\` → \`complete\` (or \`blocked\`/\`skipped\`). Assign to agent sessions via \`assigned_to\`. Attach \`result\` on completion.`,

  // Team
  personalities_create: `Create a named personality with a prompt fragment. The fragment is appended to the agent's system prompt to modify behavior/style.`,
  personalities_list: `No parameters. Returns all available personality definitions.`,
  team_abort: `Terminates the goal immediately. All agent sessions are terminated and worktrees cleaned up. Use only as a last resort.`,
  team_complete: `Call only after all work is merged to the goal branch and verified. Server requires the review gate to have passed first. Cleans up all agent worktrees.`,
  team_dismiss: `Terminates a specific agent session and cleans up its worktree. Use after the agent's work is merged back to the goal branch.`,
  team_list: `Returns all team agents with session ID, role, status, branch, and worktree path. Call frequently to monitor progress and detect finished agents.`,
  team_prompt: `Send a follow-up user message to an existing agent. Use for additional tasks after initial work completes, or to provide feedback/corrections. Supports \`workflowGateId\`/\`inputGateIds\` for context injection.`,
  team_spawn: `Each agent gets an isolated git worktree branched from the goal branch. Gate enforcement applies — server may reject with 409 if upstream gates haven't passed. Task prompt should be self-contained with all context the agent needs. Returns session ID and worktree path.`,
  team_steer: `Inject a mid-turn correction into a running agent's conversation. The agent sees it as a user message interleaved with its current work. Use sparingly — prefer letting agents finish their turn first.`,

  // Web
  web_fetch: `No JS execution — use browser tools for SPAs. Default 20K char limit; increase \`maxLength\` for long docs. Much faster than browser tools. Follows redirects. Extracts readable text, stripping navigation/ads.`,
  web_search: `DuckDuckGo HTML scraping (no API key). Max 20 results (default 10). Launch parallel searches with different phrasings for better coverage. Follow up with \`web_fetch\` for full page content.`,
};

let migrated = 0;
let skipped = 0;
let errors = 0;

for (const groupEntry of fs.readdirSync(TOOLS_DIR, { withFileTypes: true })) {
  if (!groupEntry.isDirectory()) continue;
  const groupPath = path.join(TOOLS_DIR, groupEntry.name);
  
  for (const file of fs.readdirSync(groupPath, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.yaml')) continue;
    const filePath = path.join(groupPath, file.name);
    const toolName = file.name.replace('.yaml', '');
    
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const doc = parseDocument(raw);
      
      const currentDocs = doc.get('docs');
      const existingDetailDocs = doc.get('detail_docs');
      
      // Skip if already migrated
      if (existingDetailDocs) {
        console.log(`SKIP ${toolName} — already has detail_docs`);
        skipped++;
        continue;
      }
      
      const leanDocs = LEAN_DOCS[toolName];
      if (!leanDocs) {
        console.log(`SKIP ${toolName} — no lean docs mapping`);
        skipped++;
        continue;
      }
      
      if (!currentDocs) {
        console.log(`SKIP ${toolName} — no current docs`);
        skipped++;
        continue;
      }
      
      // Move current docs to detail_docs, set lean docs
      doc.set('detail_docs', currentDocs);
      doc.set('docs', leanDocs);
      
      fs.writeFileSync(filePath, doc.toString(), 'utf-8');
      console.log(`OK   ${toolName} — docs: ${currentDocs.length} → ${leanDocs.length} chars`);
      migrated++;
    } catch (err) {
      console.error(`ERR  ${toolName}: ${err.message}`);
      errors++;
    }
  }
}

console.log(`\nDone: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
