#!/usr/bin/env node
/**
 * glm-worker.mjs — headless edit-loop driver for GLM 5.2 via NVIDIA NIM.
 *
 * Sends editable file(s) + a task + (optional) read-only context files +
 * failing test output to `z-ai/glm-5.2` (OpenAI-compatible chat completions,
 * temperature 0), applies the model's returned full-file replacements or
 * unified diffs, re-runs the test command, and feeds failures back — until
 * green or a round cap is hit.
 *
 * Why a plain chat-completions loop and not codex/an agent harness: codex CLI
 * 0.142.5 dropped the `chat` wire API and NVIDIA NIM does not implement the
 * Responses API, so codex cannot drive this model at all (see
 * ~/Documents/dev/bobbit-fable-refactor/MODEL-ROUTING-EVAL.md). This script
 * is the harness.
 *
 * Credential handling: reads NVIDIA_BUILD_KEY from the environment, or from
 * an untracked `.env` file (candidates: --env-file, ancestors of --workdir,
 * the primary git worktree root). The key is NEVER logged, NEVER echoed,
 * and NEVER written anywhere other than the Authorization header.
 *
 * Usage:
 *   node scripts/glm-worker.mjs --spec <spec.json> [--workdir <dir>]
 *     [--env-file <path>] [--max-rounds N] [--max-tokens N]
 *
 * spec.json:
 *   {
 *     "instructions": "task description for the model",
 *     "files": ["relative/path/a.ts", ...],       // editable, required
 *     "contextFiles": ["relative/path/b.test.ts"], // read-only, optional
 *     "testCommand": "node --test a.test.ts",       // required
 *     "maxRounds": 4,                                // optional, default 4
 *     "maxTokens": 8192,                              // optional
 *     "workdir": "."                                   // optional
 *   }
 *
 * Output: one JSON line per event on stdout (structured log: rounds, token
 * usage, wall-clock), followed by a final line `RESULT {...}` with a
 * machine-readable summary. Exit code 0 iff tests passed by the round cap.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = "z-ai/glm-5.2";
const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_TOKENS = 8192;
const TEST_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 4000;

function printUsage() {
  console.error(
    `Usage: node glm-worker.mjs --spec <spec.json> [--workdir <dir>] [--env-file <path>] [--max-rounds N] [--max-tokens N]\n\n` +
      `spec.json fields: instructions (str), files (str[], editable), contextFiles (str[], read-only, optional),\n` +
      `testCommand (str), maxRounds (num, optional), maxTokens (num, optional), workdir (str, optional).`
  );
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") args.spec = argv[++i];
    else if (a === "--workdir") args.workdir = argv[++i];
    else if (a === "--env-file") args.envFile = argv[++i];
    else if (a === "--max-rounds") args.maxRounds = Number(argv[++i]);
    else if (a === "--max-tokens") args.maxTokens = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return args;
}

/** Find NVIDIA_BUILD_KEY without ever logging it. */
function loadKey(envFileArg, workdir) {
  if (process.env.NVIDIA_BUILD_KEY) return process.env.NVIDIA_BUILD_KEY;

  const candidates = [];
  if (envFileArg) candidates.push(path.resolve(envFileArg));

  let dir = path.resolve(workdir);
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, ".env"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: workdir,
      encoding: "utf8",
    }).trim();
    const primaryRoot = path.dirname(path.resolve(workdir, commonDir));
    candidates.push(path.join(primaryRoot, ".env"));
  } catch {
    // Not a git repo, or git unavailable — fall through to other candidates.
  }

  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const content = readFileSync(c, "utf8");
    const m = content.match(/^NVIDIA_BUILD_KEY=(.*)$/m);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) return v;
  }

  throw new Error(
    "NVIDIA_BUILD_KEY not found in environment or any candidate .env file (checked --env-file, " +
      "ancestors of --workdir, and the primary git worktree root)."
  );
}

async function chatCompletion(key, messages, maxTokens) {
  const res = await fetch(NVIDIA_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GLM API error ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  return { content: msg?.content ?? "", usage: data.usage ?? {} };
}

/** Parse `FILE: <path>` headers followed by a fenced code block. */
export function extractFileBlocks(text) {
  const re = /FILE:\s*(\S+)\s*\n```[ \t]*(\w*)\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ filePath: m[1], lang: m[2], body: m[3] });
  }
  return blocks;
}

export function looksLikeDiff(lang, body) {
  if (/^(diff|patch)$/i.test(lang)) return true;
  const trimmed = body.trimStart();
  return trimmed.startsWith("--- ") || trimmed.startsWith("@@");
}

/**
 * Minimal unified-diff applier: walks `@@ -l,s +l,s @@` hunks by line number
 * and reconstructs the file. Fallback path for large files GLM chooses to
 * diff instead of rewrite in full — the primary, more reliable path is a
 * full-file replacement (see extractFileBlocks/looksLikeDiff above).
 */
export function applyUnifiedDiff(original, diffText) {
  const originalLines = original.split("\n");
  const diffLines = diffText.split("\n");
  const result = [];
  let oi = 0;
  let i = 0;
  while (i < diffLines.length && !diffLines[i].startsWith("@@")) i++;
  while (i < diffLines.length) {
    const hunkHeader = diffLines[i];
    const hm = hunkHeader.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hm) {
      i++;
      continue;
    }
    const startOld = parseInt(hm[1], 10) - 1;
    while (oi < startOld && oi < originalLines.length) {
      result.push(originalLines[oi]);
      oi++;
    }
    i++;
    while (i < diffLines.length && !diffLines[i].startsWith("@@")) {
      const line = diffLines[i];
      if (line.startsWith("+")) {
        result.push(line.slice(1));
      } else if (line.startsWith("-")) {
        oi++;
      } else if (line.startsWith(" ")) {
        result.push(oi < originalLines.length ? originalLines[oi] : line.slice(1));
        oi++;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file" — ignore.
      } else if (line === "") {
        result.push(oi < originalLines.length ? originalLines[oi] : "");
        oi++;
      }
      i++;
    }
  }
  while (oi < originalLines.length) {
    result.push(originalLines[oi]);
    oi++;
  }
  return result.join("\n");
}

function buildFilesBlock(workdir, files, label) {
  return files
    .map((f) => {
      const content = readFileSync(path.join(workdir, f), "utf8");
      return `=== ${label}: ${f} ===\n\`\`\`\n${content}\`\`\``;
    })
    .join("\n\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.spec) {
    printUsage();
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(path.resolve(args.spec), "utf8"));
  const workdir = path.resolve(args.workdir || spec.workdir || ".");
  const maxRounds = args.maxRounds || spec.maxRounds || DEFAULT_MAX_ROUNDS;
  const maxTokens = args.maxTokens || spec.maxTokens || DEFAULT_MAX_TOKENS;
  const testCommand = spec.testCommand;
  const editableFiles = spec.files || [];
  const contextFiles = spec.contextFiles || [];

  if (!testCommand) throw new Error("spec.testCommand is required");
  if (editableFiles.length === 0) throw new Error("spec.files must list at least one editable file");
  if (!spec.instructions) throw new Error("spec.instructions is required");

  const key = loadKey(args.envFile, workdir);

  function runTests() {
    const r = spawnSync(testCommand, {
      cwd: workdir,
      shell: true,
      encoding: "utf8",
      timeout: TEST_TIMEOUT_MS,
    });
    return { code: r.status ?? -1, output: (r.stdout || "") + (r.stderr || "") };
  }

  const t0 = Date.now();
  const log = (obj) => console.log(JSON.stringify({ tMs: Date.now() - t0, ...obj }));

  log({ event: "start", model: MODEL, workdir, editableFiles, contextFiles, testCommand, maxRounds });

  let { code: rc, output: testOut } = runTests();
  let passed = rc === 0;
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  const changedFilesAll = new Set();
  let round = 0;
  let roundsUsed = 0;

  if (passed) {
    log({ event: "already_passing" });
  } else {
    const systemPrompt = [
      "You are a headless coding worker. You will be given one or more editable source files, optional",
      "read-only context files, a task, and (if applicable) failing test output.",
      "Reply ONLY with the files you changed. For EACH changed file, output a line `FILE: <relative-path>`",
      "immediately followed by a fenced code block:",
      "- Prefer the COMPLETE new contents of the file in a plain fenced block (```<language>).",
      "- For files longer than ~400 lines you may instead output a unified diff in a ```diff fenced block,",
      "  still preceded by the FILE: line.",
      "Do not include files you did not change. Do not create new files unless the task explicitly asks for",
      "one. Never modify a file marked READ-ONLY CONTEXT. Keep changes minimal and directly aimed at the task.",
    ].join("\n");

    const userPromptParts = [`TASK:\n${spec.instructions}`, buildFilesBlock(workdir, editableFiles, "EDITABLE FILE")];
    if (contextFiles.length) userPromptParts.push(buildFilesBlock(workdir, contextFiles, "READ-ONLY CONTEXT"));
    userPromptParts.push(`TEST COMMAND: ${testCommand}`);
    userPromptParts.push(`CURRENT TEST OUTPUT:\n${testOut.slice(-OUTPUT_TAIL_CHARS)}`);
    userPromptParts.push("Reply with the fixed file(s) as instructed above.");

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPromptParts.join("\n\n") },
    ];

    for (round = 1; round <= maxRounds && !passed; round++) {
      roundsUsed = round;
      const roundStart = Date.now();
      let content, usage;
      try {
        ({ content, usage } = await chatCompletion(key, messages, maxTokens));
      } catch (err) {
        log({ event: "round_error", round, error: String((err && err.message) || err) });
        break;
      }
      totalUsage.prompt_tokens += usage.prompt_tokens || 0;
      totalUsage.completion_tokens += usage.completion_tokens || 0;

      const blocks = extractFileBlocks(content);
      if (blocks.length === 0) {
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content:
            "No `FILE: <path>` blocks found in your reply. Reply with `FILE: <path>` followed by a fenced code block for each changed file.",
        });
        log({ event: "round_no_blocks", round, ms: Date.now() - roundStart, usage });
        continue;
      }

      const roundChanged = [];
      for (const b of blocks) {
        if (!editableFiles.includes(b.filePath)) {
          log({ event: "round_skip_noneditable", round, file: b.filePath });
          continue;
        }
        const abs = path.join(workdir, b.filePath);
        if (looksLikeDiff(b.lang, b.body)) {
          const original = readFileSync(abs, "utf8");
          writeFileSync(abs, applyUnifiedDiff(original, b.body));
        } else {
          writeFileSync(abs, b.body);
        }
        roundChanged.push(b.filePath);
        changedFilesAll.add(b.filePath);
      }

      ({ code: rc, output: testOut } = runTests());
      passed = rc === 0;
      log({ event: "round_result", round, changed: roundChanged, testsPassed: passed, ms: Date.now() - roundStart, usage });

      if (!passed) {
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: `Tests still failing after applying your changes. Output:\n${testOut.slice(
            -OUTPUT_TAIL_CHARS
          )}\n\nReply with the fixed file(s) as instructed above.`,
        });
      }
    }
  }

  const wallSeconds = Math.round((Date.now() - t0) / 10) / 100;
  const result = {
    passed,
    rounds: roundsUsed,
    wallSeconds,
    usage: totalUsage,
    filesChanged: [...changedFilesAll],
  };
  console.log("RESULT " + JSON.stringify(result));
  process.exit(passed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("FATAL", (err && err.stack) || err);
    process.exit(1);
  });
}
