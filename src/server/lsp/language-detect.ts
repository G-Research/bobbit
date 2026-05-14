/**
 * Worktree → languages[] detection. Cheap synchronous file-existence checks.
 *
 * Also: extension → language mapping for per-file dispatch.
 */
import fs from "node:fs";
import path from "node:path";
import type { Language } from "./types.js";

function existsAny(root: string, names: string[]): boolean {
	for (const n of names) {
		try {
			if (fs.existsSync(path.join(root, n))) return true;
		} catch { /* ignore */ }
	}
	return false;
}

export function detectLanguages(worktreePath: string): Language[] {
	const out: Language[] = [];
	if (existsAny(worktreePath, ["tsconfig.json", "jsconfig.json", "package.json"])) {
		out.push("typescript");
	}
	if (existsAny(worktreePath, ["pyproject.toml", "requirements.txt", "setup.py"])) {
		out.push("python");
	}
	return out;
}

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const PY_EXTS = new Set([".py", ".pyi"]);

export function languageForFile(filePath: string): Language | null {
	const ext = path.extname(filePath).toLowerCase();
	if (TS_EXTS.has(ext)) return "typescript";
	if (PY_EXTS.has(ext)) return "python";
	return null;
}

/**
 * Walk upward from `cwd` looking for a project root marker. Used by gateway
 * LSP route to derive the worktree path the supervisor should bind to.
 */
export function findProjectRoot(startDir: string, language: Language): string {
	const markers = language === "typescript"
		? ["tsconfig.json", "jsconfig.json", "package.json"]
		: ["pyproject.toml", "setup.py", "requirements.txt"];
	let cur = path.resolve(startDir);
	const root = path.parse(cur).root;
	while (true) {
		if (existsAny(cur, markers)) return cur;
		if (cur === root) return path.resolve(startDir);
		const parent = path.dirname(cur);
		if (parent === cur) return path.resolve(startDir);
		cur = parent;
	}
}
