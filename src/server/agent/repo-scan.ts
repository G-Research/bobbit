/**
 * Repo scanner for project assistant + Settings → "Re-scan repos".
 *
 * Walks `rootPath` and exactly one level beneath it, classifying each entry
 * as a repo (has `.git`) and parsing its manifest (`package.json`,
 * `pyproject.toml`, `Cargo.toml`) into a flat `commands` map suggestion.
 *
 * Single-repo (rootPath itself is a git repo) returns `[{folder: "."}]`.
 * Multi-repo (rootPath has no `.git`, children do) returns one entry per
 * child with `.git`. Mixed (rootPath has `.git` and children also have
 * their own) returns rootPath as `"."` plus the child repos.
 *
 * Pure detection — no network, no git invocations, no symlink following.
 *
 * See docs/design/multi-repo-components.md §2.2.
 */

import fs from "node:fs";
import path from "node:path";

export interface DetectedRepo {
	/** Relative to rootPath; "." for the root itself. */
	folder: string;
	/** True if `<folder>/.git` exists (file or dir). */
	hasGit: boolean;
	/** Suggested commands map (e.g. {build: "npm run build"}). May be empty for data-only. */
	detectedCommands: Record<string, string>;
}

const SKIP_NAMES = new Set(["node_modules", ".bobbit"]);

function hasGit(absDir: string): boolean {
	try {
		const gitPath = path.join(absDir, ".git");
		return fs.existsSync(gitPath);
	} catch { return false; }
}

function safeReadFile(p: string): string | undefined {
	try { return fs.readFileSync(p, "utf-8"); } catch { return undefined; }
}

/**
 * Tiny, intentionally-limited TOML scanner. Handles the subset we need:
 *   - section headers `[a.b.c]`
 *   - key = "string"
 *   - key = 'string'
 *   - key = bareword  (treated as string)
 * Comments (`# …`) and trailing whitespace are stripped.
 *
 * Not a general-purpose parser. Good enough for `[tool.poetry.scripts]`,
 * `[tool.pdm.scripts]`, and `[bin]` `name = "x"` blocks.
 */
function parseSimpleToml(text: string): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	let section = "";
	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		// Strip comments (naive; not aware of strings).
		const hashIdx = rawLine.indexOf("#");
		const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
		if (!line) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1).trim();
			if (!out[section]) out[section] = {};
			continue;
		}
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		if (!section) continue;
		if (!out[section]) out[section] = {};
		out[section][key] = val;
	}
	return out;
}

/**
 * Section-aware multi-table TOML scanner. Like `parseSimpleToml` but
 * preserves multiple `[bin]` blocks (Cargo.toml's array-of-tables) so we
 * can collect every binary's `name`.
 */
function parseTomlSections(text: string): Array<{ section: string; entries: Record<string, string> }> {
	const out: Array<{ section: string; entries: Record<string, string> }> = [];
	let current: { section: string; entries: Record<string, string> } | null = null;
	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		const hashIdx = rawLine.indexOf("#");
		const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
		if (!line) continue;
		if (line.startsWith("[[") && line.endsWith("]]")) {
			if (current) out.push(current);
			current = { section: line.slice(2, -2).trim(), entries: {} };
			continue;
		}
		if (line.startsWith("[") && line.endsWith("]")) {
			if (current) out.push(current);
			current = { section: line.slice(1, -1).trim(), entries: {} };
			continue;
		}
		const eq = line.indexOf("=");
		if (eq < 0 || !current) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		current.entries[key] = val;
	}
	if (current) out.push(current);
	return out;
}

/** Detect commands for a single repo folder. */
function detectCommands(absDir: string): Record<string, string> {
	const out: Record<string, string> = {};

	// package.json scripts — keep names verbatim.
	const pkg = safeReadFile(path.join(absDir, "package.json"));
	if (pkg) {
		try {
			const parsed = JSON.parse(pkg);
			const scripts = parsed?.scripts;
			if (scripts && typeof scripts === "object") {
				for (const [k, v] of Object.entries(scripts)) {
					if (typeof v === "string" && v.length > 0) out[k] = `npm run ${k}`;
				}
			}
		} catch { /* malformed */ }
	}

	// pyproject.toml — [tool.poetry.scripts] / [tool.pdm.scripts]
	const py = safeReadFile(path.join(absDir, "pyproject.toml"));
	if (py) {
		const parsed = parseSimpleToml(py);
		for (const sect of ["tool.poetry.scripts", "tool.pdm.scripts"]) {
			const entries = parsed[sect];
			if (!entries) continue;
			for (const [k, v] of Object.entries(entries)) {
				if (!out[k]) out[k] = v;
			}
		}
	}

	// Cargo.toml — [[bin]] name = "x"  →  name → "cargo run --bin x"
	const cargo = safeReadFile(path.join(absDir, "Cargo.toml"));
	if (cargo) {
		const sections = parseTomlSections(cargo);
		for (const s of sections) {
			if (s.section !== "bin") continue;
			const name = s.entries.name;
			if (name && !out[name]) out[name] = `cargo run --bin ${name}`;
		}
	}

	return out;
}

export async function scanRepos(
	rootPath: string,
	_opts?: { maxDepth?: 1 },
): Promise<DetectedRepo[]> {
	const out: DetectedRepo[] = [];
	const rootAbs = path.resolve(rootPath);

	if (!fs.existsSync(rootAbs)) return out;

	// Resolve the root once so the symlink check below tolerates ancestor-level
	// symlinks (e.g. macOS `/tmp` → `/private/tmp`). We only want to reject
	// symlinks that escape the rootPath, not those introduced by the OS itself.
	let rootReal = rootAbs;
	try { rootReal = fs.realpathSync(rootAbs); } catch { /* leave as rootAbs */ }

	const rootHasGit = hasGit(rootAbs);
	if (rootHasGit) {
		out.push({ folder: ".", hasGit: true, detectedCommands: detectCommands(rootAbs) });
	}

	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(rootAbs, { withFileTypes: true });
	} catch { return out; }

	for (const e of entries) {
		if (!e.isDirectory() && !e.isSymbolicLink()) continue;
		const name = e.name;
		if (name.startsWith(".")) continue;       // .git, dotfiles
		if (SKIP_NAMES.has(name)) continue;

		const absChild = path.join(rootAbs, name);
		// Symlink protection: skip only if the child's realpath escapes the
		// root's realpath. Ancestor-level symlinks (e.g. /tmp → /private/tmp)
		// are tolerated because `realChild` will share `rootReal` as a prefix.
		try {
			const realChild = fs.realpathSync(absChild);
			const expected = path.join(rootReal, name);
			if (realChild !== expected) {
				console.warn(`[repo-scan] Skipping symlinked entry: ${absChild} -> ${realChild}`);
				continue;
			}
		} catch { /* realpath may fail on dangling symlink */ continue; }

		const childHasGit = hasGit(absChild);
		const childCommands = detectCommands(absChild);

		// Only emit a child entry if it's a repo OR has a recognizable manifest.
		// Pure data dirs without `.git` and no manifests are skipped.
		const hasManifest = Object.keys(childCommands).length > 0
			|| fs.existsSync(path.join(absChild, "package.json"))
			|| fs.existsSync(path.join(absChild, "pyproject.toml"))
			|| fs.existsSync(path.join(absChild, "Cargo.toml"));

		if (childHasGit) {
			out.push({ folder: name, hasGit: true, detectedCommands: childCommands });
		} else if (!rootHasGit && hasManifest) {
			// Monorepo case: rootPath has no `.git` but children carry manifests
			// (each is a logical sub-package). Surface them as data-only-ish
			// components — caller decides whether to treat them as repos.
			out.push({ folder: name, hasGit: false, detectedCommands: childCommands });
		}
	}

	return out;
}
