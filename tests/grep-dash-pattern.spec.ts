/**
 * Reproducing test for the grep `--` pattern bug.
 *
 * When the grep tool receives a pattern starting with `--` (e.g. `--extension`),
 * ripgrep interprets it as a command-line flag instead of a search pattern,
 * because grep.js pushes the pattern directly into args without a `--`
 * end-of-options separator (grep.js line ~96: `args.push(pattern, searchPath)`).
 *
 * The bash workaround (`rg -- '--extension' src/`) works correctly.
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { accessSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve rg the same way the grep tool does (via pi-coding-agent's tools-manager)
let rgPath: string;
try {
	// The tool manager caches rg at ~/.pi/agent/bin/rg.exe (Windows) or ~/.pi/agent/bin/rg
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const candidates = [
		resolve(home, ".pi/agent/bin/rg.exe"),
		resolve(home, ".pi/agent/bin/rg"),
	];
	rgPath = candidates.find((p) => {
		try { accessSync(p); return true; } catch { return false; }
	}) || "rg";
} catch {
	rgPath = "rg";
}

const searchPath = resolve(__dirname, "..", "src", "server");

test("rg fails when --prefixed pattern is passed without -- separator (the bug)", () => {
	// This reproduces what grep.js does: args.push(pattern, searchPath)
	// with no -- separator before the pattern.
	try {
		execFileSync(rgPath, ["--json", "--line-number", "--color=never", "--hidden", "--extension", searchPath], {
			encoding: "utf8",
			timeout: 10_000,
		});
		// If it doesn't throw, check stderr
		expect.unreachable("Expected rg to fail with unrecognized flag");
	} catch (err: any) {
		expect(err.stderr || err.message).toContain("unrecognized flag");
	}
});

test("rg succeeds when -- separator is used before --prefixed pattern (the workaround)", () => {
	const result = execFileSync(rgPath, ["--line-number", "--color=never", "--hidden", "--", "--extension", searchPath], {
		encoding: "utf8",
		timeout: 10_000,
	});
	// Should find matches — --extension appears in several server files
	expect(result).toContain("--extension");
	expect(result.split("\n").filter((l) => l.trim()).length).toBeGreaterThan(0);
});
