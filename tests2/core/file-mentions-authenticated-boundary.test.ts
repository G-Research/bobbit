import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const AUTHENTICATED_PROMPT_BYTES = 8 * 1024 * 1024;
const CHILD_OLD_SPACE_MIB = 256;
const CHILD_TIMEOUT_MS = 13_000;
const TEST_TIMEOUT_MS = 14_500;

function childDriver(bundlePath: string): string {
	return `
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveFileMentions,
  buildFileReferenceBlock,
} from ${JSON.stringify(pathToFileURL(bundlePath).href)};

const AUTHENTICATED_PROMPT_BYTES = ${AUTHENTICATED_PROMPT_BYTES};
const NOTES_CONTENT = "hello world\\nline two";
const OUTSIDE_MISSING = "@authenticated-boundary-missing.txt";
const OUTSIDE_VALID = "@notes.txt";
const SUFFIX = "\\n\\n😀 missing " + OUTSIDE_MISSING + " valid " + OUTSIDE_VALID + ".";
const BACKTICK = String.fromCharCode(96);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "file-mention-child-boundary-"));
fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
fs.writeFileSync(path.join(cwd, "notes.txt"), NOTES_CONTENT, "utf8");
fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const x = 1;", "utf8");

function exactBoundaryPrompt(unit, prefix = "") {
  const fixedBytes = Buffer.byteLength(prefix + SUFFIX, "utf8");
  const repetitions = Math.floor(
    (AUTHENTICATED_PROMPT_BYTES - fixedBytes) / Buffer.byteLength(unit, "utf8"),
  );
  const paddingBytes = AUTHENTICATED_PROMPT_BYTES
    - fixedBytes
    - repetitions * Buffer.byteLength(unit, "utf8");
  const text = prefix + unit.repeat(repetitions) + "x".repeat(paddingBytes) + SUFFIX;
  assert.equal(Buffer.byteLength(text, "utf8"), AUTHENTICATED_PROMPT_BYTES);
  return { text, repetitions };
}

function codeDensePrompt() {
  const block = [
    BACKTICK.repeat(3) + "text\\r\\n",
    "@src/a.ts @code-dense-only-missing.txt @variableName\\r\\n",
    BACKTICK.repeat(3) + "\\r\\n",
  ].join("");
  const blockRepetitions = 3_000;
  const { text } = exactBoundaryPrompt(BACKTICK + "\\r\\n\\r\\n", block.repeat(blockRepetitions));
  return { text, excludedCandidates: blockRepetitions * 3 };
}

function ultraDeepPrompt() {
  const codeTokens = Array.from(
    { length: 8_193 },
    (_, index) => index % 2 === 0
      ? "@src/a.ts"
      : "@deep-code-only-" + (index % 8) + ".txt",
  );
  const terminal = BACKTICK + codeTokens.join(" ") + BACKTICK;
  const fixedBytes = Buffer.byteLength(terminal + SUFFIX, "utf8");
  const markerCount = Math.floor((AUTHENTICATED_PROMPT_BYTES - fixedBytes) / 2);
  const paddingBytes = AUTHENTICATED_PROMPT_BYTES - fixedBytes - markerCount * 2;
  const text = "- ".repeat(markerCount) + " ".repeat(paddingBytes) + terminal + SUFFIX;
  assert.equal(Buffer.byteLength(text, "utf8"), AUTHENTICATED_PROMPT_BYTES);
  return { text, excludedCandidates: codeTokens.length };
}

async function verifyExactResolution(label, fixture) {
  const { text, excludedCandidates } = fixture;
  const tokenStart = text.lastIndexOf(OUTSIDE_VALID);
  const tokenEnd = tokenStart + OUTSIDE_VALID.length;
  const notesPath = path.join(cwd, "notes.txt");
  const missingPath = path.join(cwd, OUTSIDE_MISSING.slice(1));
  const codeOnlyPath = path.join(cwd, "src", "a.ts");
  const originalLstat = fs.promises.lstat.bind(fs.promises);
  const lstatTargets = [];
  fs.promises.lstat = async (target, ...args) => {
    lstatTargets.push(path.resolve(String(target)));
    return await originalLstat(target, ...args);
  };

  try {
    assert.ok(excludedCandidates > 8_192);
    assert.equal(Buffer.byteLength(text.slice(0, tokenStart), "utf8"), tokenStart + 2);
    const result = await resolveFileMentions(text, cwd);
    assert.equal(result.originalText, text);
    assert.deepEqual(
      result.mentions.map((mention) => ({
        kind: mention.kind,
        path: mention.path,
        range: mention.range,
      })),
      [{ kind: "text", path: "notes.txt", range: [tokenStart, tokenEnd] }],
    );
    assert.equal(
      result.modelText,
      text.slice(0, tokenStart)
        + buildFileReferenceBlock("notes.txt", NOTES_CONTENT)
        + text.slice(tokenEnd),
    );
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(lstatTargets.slice().sort(), [missingPath, notesPath].sort());
    assert.ok(!lstatTargets.includes(codeOnlyPath));
    return { label, bytes: Buffer.byteLength(text, "utf8"), range: [tokenStart, tokenEnd] };
  } finally {
    fs.promises.lstat = originalLstat;
  }
}

const cases = [];
try {
  for (let repetition = 0; repetition < 2; repetition++) {
    cases.push(await verifyExactResolution("code-dense", codeDensePrompt()));
    global.gc?.();
  }
  for (let repetition = 0; repetition < 2; repetition++) {
    cases.push(await verifyExactResolution("ultra-deep", ultraDeepPrompt()));
    global.gc?.();
  }
  console.log(JSON.stringify({ ok: true, cases }));
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
`;
}

function oneLineFailure(result: ReturnType<typeof spawnSync>): string {
	const stderr = String(result.stderr ?? "");
	const fatal = stderr.match(/FATAL ERROR:[^\r\n]*/)?.[0];
	const detail = fatal
		?? result.error?.message
		?? stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
		?? "no child diagnostic";
	return detail.replace(/\s+/g, " ").slice(0, 600);
}

describe("file mention exact authenticated prompt boundary", () => {
	it("repeatedly resolves code-dense and ultra-deep exact 8 MiB prompts within a constrained child heap", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-mention-resource-child-"));
		try {
			const bundlePath = path.join(tempDir, "resolver.mjs");
			const driverPath = path.join(tempDir, "driver.mjs");
			buildSync({
				entryPoints: [path.resolve("src/server/skills/resolve-file-mentions.ts")],
				outfile: bundlePath,
				bundle: true,
				platform: "node",
				format: "esm",
				target: "node22",
				logLevel: "silent",
			});
			fs.writeFileSync(driverPath, childDriver(bundlePath), "utf8");

			const result = spawnSync(
				process.execPath,
				[
					`--max-old-space-size=${CHILD_OLD_SPACE_MIB}`,
					"--expose-gc",
					driverPath,
				],
				{
					cwd: path.resolve("."),
					encoding: "utf8",
					maxBuffer: 2 * 1024 * 1024,
					timeout: CHILD_TIMEOUT_MS,
				},
			);
			if (result.status !== 0) {
				assert.fail(
					`bounded Markdown scanner child failed under ${CHILD_OLD_SPACE_MIB} MiB old-space `
					+ `(status=${String(result.status)}, signal=${String(result.signal)}): ${oneLineFailure(result)}`,
				);
			}

			const outputLine = String(result.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1);
			assert.ok(outputLine, "bounded Markdown scanner child must emit its semantic result");
			const output = JSON.parse(outputLine) as {
				ok: boolean;
				cases: Array<{ label: string; bytes: number; range: [number, number] }>;
			};
			assert.equal(output.ok, true);
			assert.deepEqual(
				output.cases.map(({ label, bytes }) => ({ label, bytes })),
				[
					{ label: "code-dense", bytes: AUTHENTICATED_PROMPT_BYTES },
					{ label: "code-dense", bytes: AUTHENTICATED_PROMPT_BYTES },
					{ label: "ultra-deep", bytes: AUTHENTICATED_PROMPT_BYTES },
					{ label: "ultra-deep", bytes: AUTHENTICATED_PROMPT_BYTES },
				],
			);
			assert.ok(output.cases.every(({ range }) => range[1] - range[0] === "@notes.txt".length));
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}, TEST_TIMEOUT_MS);
});
