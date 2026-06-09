/**
 * Guard test (acceptance #2): the per-capability server-module sandbox is GONE, with
 * zero residual references anywhere in the extension-host / marketplace surface.
 *
 * Pack server code is TRUSTED (the tool/MCP tier) and runs with full ambient parity;
 * the only isolation kept is resource/crash isolation + module-import containment. The
 * deleted sandbox's concept (the manifest opt-in key + the OS-capability gating logic)
 * must leave NO trace — not in source, tests, packs, comments, or the extension-host
 * docs.
 *
 * FRAGMENT TRICK: this test file lives inside one of the scanned roots (`tests/`), so a
 * literal copy of any forbidden token in its own source would be a self-inflicted hit /
 * exception hole. So every forbidden-token search needle is ASSEMBLED FROM CONCATENATED
 * FRAGMENTS at runtime (`frag("permis", "sion")` etc.) — no complete forbidden token
 * appears as a literal anywhere in this source. The two files that legitimately describe
 * the removal (this guard + the planning design doc) are ALSO excluded from the scan, so
 * there is no exception hole and no self-match.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Assemble a needle from fragments so the complete token never appears literally. */
const frag = (...parts: string[]): string => parts.join("");

// Forbidden bare words (case-insensitive) for the surface scan.
const W_PERMISSION = frag("permis", "sion");
const W_GRANT = frag("gr", "ant");

// Unique sandbox identifiers (exact, case-sensitive) — these names are unique to the
// deleted sandbox, so they cannot false-positive against unrelated grant/permission code.
const SANDBOX_IDENTS = [
	frag("Pack", "Permis", "sion"),
	frag("denied", "For", "Gr", "ants"),
	frag("normalize", "Gr", "ants"),
	frag("keep", "Network", "Globals"),
	frag("needs", "Real", "Process"),
	frag("GR", "ANT", "_DENIED_REMOVALS"),
	frag("parse", "Permis", "sions"),
	frag("permis", "sion", "-", "gr", "ants"),
	frag("PACK_", "PERMIS", "SION_VALUES"),
];

// Sandbox-framing terms + the manifest key token, for the doc scan (case-insensitive).
const DOC_FRAMING = [
	frag("Pack", "Permis", "sion"),
	frag("denied", "For", "Gr", "ants"),
	frag("permis", "sion", "-", "gr", "ants"),
	frag("per-", "capability"),
	frag("capability ", "sandbox"),
	frag("declared-", "permis", "sion"),
	frag("deny-", "all"),
	frag("permis", "sions:"),
];

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yaml", ".yml", ".txt", ".html", ".css"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

// Never scanned — they describe the removal and would self-match (no exception hole).
const EXCLUDE = new Set([
	path.join(REPO_ROOT, "tests", "extension-host-no-capability-sandbox-residual.test.ts"),
	path.join(REPO_ROOT, "docs", "design", "extension-host-isolation-simplification.md"),
]);

/** Recursively collect text files under `dir`, skipping excluded dirs/files. */
function collectFiles(dir: string): string[] {
	const out: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const abs = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			out.push(...collectFiles(abs));
		} else if (e.isFile()) {
			if (EXCLUDE.has(abs)) continue;
			if (!TEXT_EXT.has(path.extname(e.name))) continue;
			out.push(abs);
		}
	}
	return out;
}

function readText(abs: string): string {
	try {
		return fs.readFileSync(abs, "utf8");
	} catch {
		return "";
	}
}

const ROOTS = ["src", "tests", "docs", "market-packs"].map((r) => path.join(REPO_ROOT, r));

describe("extension-host — no residual capability-sandbox references (acceptance #2)", () => {
	it("the unique sandbox identifiers appear NOWHERE under src/ tests/ docs/ market-packs/", () => {
		const offenders: string[] = [];
		for (const root of ROOTS) {
			for (const abs of collectFiles(root)) {
				const text = readText(abs);
				for (const ident of SANDBOX_IDENTS) {
					if (text.includes(ident)) offenders.push(`${path.relative(REPO_ROOT, abs)} :: ${ident}`);
				}
			}
		}
		assert.deepEqual(offenders, [], `unique sandbox identifiers must have zero residual references:\n${offenders.join("\n")}`);
	});

	it("the extension-host source/test/pack surface contains neither forbidden word (case-insensitive)", () => {
		const surface: string[] = [];
		surface.push(...collectFiles(path.join(REPO_ROOT, "src", "server", "extension-host")));
		surface.push(path.join(REPO_ROOT, "src", "server", "agent", "tool-contributions.ts"));
		surface.push(path.join(REPO_ROOT, "tests", "extension-host-module-isolation.test.ts"));
		surface.push(path.join(REPO_ROOT, "tests", "extension-host-isolation-config-invariant.test.ts"));
		surface.push(...collectFiles(path.join(REPO_ROOT, "market-packs", "pr-walkthrough")));

		const offenders: string[] = [];
		for (const abs of surface) {
			const lower = readText(abs).toLowerCase();
			if (lower.includes(W_PERMISSION)) offenders.push(`${path.relative(REPO_ROOT, abs)} :: ${W_PERMISSION}`);
			if (lower.includes(W_GRANT)) offenders.push(`${path.relative(REPO_ROOT, abs)} :: ${W_GRANT}`);
		}
		assert.deepEqual(offenders, [], `the extension-host surface must contain neither forbidden word:\n${offenders.join("\n")}`);
	});

	it("the deleted sandbox source file no longer exists on disk", () => {
		const deleted = path.join(REPO_ROOT, "src", "server", "extension-host", frag("permis", "sion", "-", "gr", "ants.ts"));
		assert.equal(fs.existsSync(deleted), false, "the deleted sandbox module must not exist");
	});

	it("the extension-host docs contain no sandbox-framing terms or the manifest key token", () => {
		const docs = [
			path.join(REPO_ROOT, "docs", "design", "extension-host.md"),
			path.join(REPO_ROOT, "docs", "design", "extension-host-phase2.md"),
			path.join(REPO_ROOT, "docs", "marketplace.md"),
			path.join(REPO_ROOT, "docs", "extension-host-authoring.md"),
		];
		const offenders: string[] = [];
		for (const abs of docs) {
			const lower = readText(abs).toLowerCase();
			for (const term of DOC_FRAMING) {
				if (lower.includes(term.toLowerCase())) offenders.push(`${path.relative(REPO_ROOT, abs)} :: ${term}`);
			}
		}
		assert.deepEqual(offenders, [], `extension-host docs must drop all sandbox framing:\n${offenders.join("\n")}`);
	});
});
