import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
	computePiExtensionDiscoveryCacheKeyWithDiagnostics,
	makePiExtensionDiagnostic,
	type PiExtensionDiagnostic,
	type PiExtensionDiscoveryResult,
	type PiExtensionToolInfo,
} from "./pi-extension-contributions.js";

export interface PiExtensionDiscoveryProbeRequest {
	entryPath: string;
	timeoutMs: number;
	cwd?: string;
}

export interface PiExtensionDiscoveryProbeResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

/**
 * Injectable executable-discovery boundary. Unit tests use an in-memory backend;
 * production defaults to the real, confined Node child-process backend below.
 */
export interface PiExtensionDiscoveryBackend {
	run(request: PiExtensionDiscoveryProbeRequest): Promise<PiExtensionDiscoveryProbeResult>;
	runSync(request: PiExtensionDiscoveryProbeRequest): PiExtensionDiscoveryProbeResult;
}

export interface DiscoverPiExtensionToolsOptions {
	timeoutMs?: number;
	cwd?: string;
	trustAccepted: boolean;
	backend?: PiExtensionDiscoveryBackend;
}

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 128 * 1024;
export const PI_EXTENSION_DISCOVERY_RESULT_MARKER = "__BOBBIT_PI_EXTENSION_DISCOVERY_RESULT__";
const RESULT_MARKER = PI_EXTENSION_DISCOVERY_RESULT_MARKER;
const DENIED_PROBE_IMPORTS = ["child_process", "cluster", "dgram", "dns", "http", "http2", "https", "inspector", "net", "repl", "tls", "undici", "worker_threads"] as const;
const require = createRequire(import.meta.url);

function diagnostic(status: PiExtensionDiagnostic["status"], code: string, message: string): PiExtensionDiagnostic {
	return makePiExtensionDiagnostic(status, code, message);
}

function skipped(cacheKey?: string): PiExtensionDiscoveryResult {
	return {
		status: "skipped",
		tools: [],
		...(cacheKey ? { cacheKey } : {}),
		diagnostic: diagnostic("ok", "trust_required", "Executable discovery is skipped until the marketplace source is trusted."),
	};
}

function failed(code: string, message: string, cacheKey?: string): PiExtensionDiscoveryResult {
	return {
		status: "failed",
		tools: [],
		...(cacheKey ? { cacheKey } : {}),
		diagnostic: diagnostic("discovery-failed", code, message),
	};
}

function ok(tools: PiExtensionToolInfo[], cacheKey?: string): PiExtensionDiscoveryResult {
	return {
		status: "ok",
		tools,
		...(cacheKey ? { cacheKey } : {}),
	};
}

function safeExecArgv(argv: readonly string[]): string[] {
	const out: string[] = [];
	const flagsWithValue = new Set(["--conditions", "-C"]);
	const safePrefixes = ["--conditions="];
	// The probe imports only generated .mjs files. Forwarding parent loader hooks
	// (tsx/playwright transform caches, --require shims, etc.) can make a built
	// E2E probe execute CommonJS-shaped helper JS inside Bobbit's ESM package and
	// fail before our probe script runs.
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		const prefix = safePrefixes.find((p) => arg.startsWith(p));
		if (prefix) {
			out.push(arg);
			continue;
		}
		if (flagsWithValue.has(arg)) {
			const value = argv[i + 1];
			if (typeof value === "string") {
				out.push(arg, value);
				i++;
			}
		}
	}
	return out;
}

function minimalEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "HOME", "USERPROFILE"]) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	// Explicitly remove Bobbit/provider/session secrets from executable discovery.
	for (const key of Object.keys(env)) {
		if (/^(BOBBIT_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AWS_|AZURE_)/i.test(key)) delete env[key];
	}
	return env;
}

function boundedAppend(current: string, chunk: Buffer): string {
	const next = current + chunk.toString("utf-8");
	if (Buffer.byteLength(next, "utf-8") <= MAX_OUTPUT_BYTES) return next;
	return next.slice(-MAX_OUTPUT_BYTES);
}

function sanitizeMessage(value: unknown): string {
	const raw = value instanceof Error ? value.message : String(value ?? "unknown error");
	return raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 1000) || "unknown error";
}

function isUnsettledTopLevelAwaitOutput(output: string): boolean {
	return /unsettled top-level await/i.test(output);
}

function parseProbeResult(stdout: string): { status: "ok"; tools: PiExtensionToolInfo[] } | { status: "failed"; code: string; message: string } | null {
	const idx = stdout.lastIndexOf(RESULT_MARKER);
	if (idx < 0) return null;
	const tail = stdout.slice(idx + RESULT_MARKER.length).trimStart();
	const line = tail.split(/\r?\n/, 1)[0] ?? "";
	try {
		const parsed = JSON.parse(line) as any;
		if (parsed?.status === "ok" && Array.isArray(parsed.tools)) return { status: "ok", tools: normalizeTools(parsed.tools) };
		if (parsed?.status === "failed") return { status: "failed", code: String(parsed.code || "probe_failed"), message: sanitizeMessage(parsed.message) };
	} catch { /* fall through */ }
	return null;
}

function normalizeTools(raw: unknown[]): PiExtensionToolInfo[] {
	const out: PiExtensionToolInfo[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const obj = item as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		if (!name || seen.has(name)) continue;
		seen.add(name);
		const tool: PiExtensionToolInfo = { name };
		if (typeof obj.description === "string" && obj.description.trim()) tool.description = obj.description.trim();
		if (obj.inputSchema && typeof obj.inputSchema === "object" && !Array.isArray(obj.inputSchema)) tool.inputSchema = obj.inputSchema as Record<string, unknown>;
		out.push(tool);
	}
	return out;
}

class ProbePreparationError extends Error {
	constructor(public readonly code: string, message: string) {
		super(message);
	}
}

function isDeniedProbeImport(specifier: string): boolean {
	const normalized = specifier.replace(/^node:/, "");
	return DENIED_PROBE_IMPORTS.some((denied) => normalized === denied || normalized.startsWith(`${denied}/`));
}

function isNodeBuiltinImport(specifier: string): boolean {
	const normalized = specifier.replace(/^node:/, "");
	return builtinModules.includes(normalized) || builtinModules.includes(`node:${normalized}`);
}

function isPathInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertRealPathInsideSource(sourceRootReal: string, target: string, detail: string): string {
	let targetReal: string;
	try {
		targetReal = fs.realpathSync(target);
	} catch (err) {
		throw new ProbePreparationError("probe_build_failed", `Pi extension discovery could not resolve ${detail}: ${sanitizeMessage(err)}`);
	}
	if (!isPathInside(sourceRootReal, targetReal)) {
		throw new ProbePreparationError("PROBE_FS_READ_DENIED", `Pi extension discovery refused to bundle ${detail} outside the extension source root.`);
	}
	return targetReal;
}

function packageJsonEntry(pkgPath: string): string | null {
	try {
		const data = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
		for (const key of ["module", "main"]) {
			const value = data[key];
			if (typeof value === "string" && value.trim()) return path.resolve(path.dirname(pkgPath), value);
		}
	} catch { /* ignore invalid package metadata; try index candidates */ }
	return null;
}

function resolveImportCandidate(base: string): string | null {
	const candidates = [base];
	if (!path.extname(base)) candidates.push(...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"].map((ext) => `${base}${ext}`));
	for (const candidate of candidates) {
		try {
			const st = fs.lstatSync(candidate);
			if (st.isSymbolicLink() || st.isFile()) return candidate;
		} catch { /* continue */ }
	}
	try {
		const st = fs.lstatSync(base);
		if (st.isSymbolicLink()) return base;
		if (st.isDirectory()) {
			const pkgEntry = packageJsonEntry(path.join(base, "package.json"));
			if (pkgEntry) {
				const resolved = resolveImportCandidate(pkgEntry);
				if (resolved) return resolved;
			}
			for (const name of ["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.mjs", "index.cjs", "index.json"]) {
				const resolved = resolveImportCandidate(path.join(base, name));
				if (resolved) return resolved;
			}
		}
	} catch { /* continue */ }
	return null;
}

function packageImportBase(specifier: string, sourceRootReal: string): string {
	const parts = specifier.split("/");
	const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? "";
	const subpath = specifier.startsWith("@") ? parts.slice(2) : parts.slice(1);
	return path.join(sourceRootReal, "node_modules", packageName, ...subpath);
}

function isPackageSpecifier(specifier: string): boolean {
	return !path.isAbsolute(specifier) && !specifier.startsWith(".") && !specifier.startsWith("/") && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier) && !isNodeBuiltinImport(specifier);
}

function resolveConfinedImport(specifier: string, fromDir: string, sourceRootReal: string): string | null {
	if (isDeniedProbeImport(specifier)) throw new ProbePreparationError("PROBE_CONFINEMENT_DENIED", `Pi extension discovery probe denied import of ${specifier} during executable discovery.`);
	if (isNodeBuiltinImport(specifier)) return null;
	if (!path.isAbsolute(specifier) && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) throw new ProbePreparationError("PROBE_FS_READ_DENIED", `Pi extension discovery refused to bundle URL import ${specifier}.`);
	const packageSpecifier = isPackageSpecifier(specifier);
	const base = (path.isAbsolute(specifier) || specifier.startsWith(".") || specifier.startsWith("/"))
		? path.resolve(fromDir, specifier)
		: packageImportBase(specifier, sourceRootReal);
	if (!isPathInside(sourceRootReal, base)) {
		throw new ProbePreparationError("PROBE_FS_READ_DENIED", `Pi extension discovery refused to resolve import ${specifier} outside the extension source root.`);
	}
	const resolved = resolveImportCandidate(base);
	if (!resolved) {
		if (packageSpecifier) {
			throw new ProbePreparationError("PROBE_FS_READ_DENIED", `Pi extension discovery refused to resolve package import ${specifier} outside the extension source root. Only extension-local node_modules packages may be bundled.`);
		}
		throw new ProbePreparationError("probe_build_failed", `Pi extension discovery could not resolve import ${specifier}.`);
	}
	return assertRealPathInsideSource(sourceRootReal, resolved, `import ${specifier}`);
}

function importSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const patterns = [
		/\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
		/\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\brequire\s*\.\s*resolve\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
			if (match[1]) specifiers.push(match[1]);
		}
	}
	return specifiers;
}

function assertTypeScriptBundleConfined(entryPath: string): void {
	const sourceRootReal = fs.realpathSync(inferAllowedSourceRoot(entryPath));
	const seen = new Set<string>();
	const visit = (file: string): void => {
		const real = assertRealPathInsideSource(sourceRootReal, file, seen.size ? `import ${file}` : "entry file");
		if (seen.has(real)) return;
		seen.add(real);
		if (![".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(path.extname(real).toLowerCase())) return;
		const source = fs.readFileSync(real, "utf-8");
		for (const specifier of importSpecifiers(source)) {
			const resolved = resolveConfinedImport(specifier, path.dirname(real), sourceRootReal);
			if (resolved) visit(resolved);
		}
	};
	visit(entryPath);
}

function typeScriptBundleWorkerScript(): string {
	return String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");
const [entryPath, outFile, sourceRootReal, esbuildPath] = process.argv.slice(2);
const DENIED_PROBE_IMPORTS = ${JSON.stringify(DENIED_PROBE_IMPORTS)};
let preparationError = null;
class ProbePreparationError extends Error { constructor(code, message) { super(message); this.code = code; } }
function isDeniedProbeImport(specifier) { const normalized = String(specifier || "").replace(/^node:/, ""); return DENIED_PROBE_IMPORTS.some((denied) => normalized === denied || normalized.startsWith(denied + "/")); }
function isNodeBuiltinImport(specifier) { const normalized = String(specifier || "").replace(/^node:/, ""); return builtinModules.includes(normalized) || builtinModules.includes("node:" + normalized); }
function isPathInside(root, target) { const rel = path.relative(root, target); return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)); }
function assertRealPathInsideSource(target, detail) { let targetReal; try { targetReal = fs.realpathSync(target); } catch (err) { throw new ProbePreparationError("probe_build_failed", "Pi extension discovery could not resolve " + detail + ": " + sanitizeMessage(err)); } if (!isPathInside(sourceRootReal, targetReal)) throw new ProbePreparationError("PROBE_FS_READ_DENIED", "Pi extension discovery refused to bundle " + detail + " outside the extension source root."); return targetReal; }
function sanitizeMessage(value) { const raw = value && value.message ? String(value.message) : String(value ?? "unknown error"); return raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 1000) || "unknown error"; }
function packageJsonEntry(pkgPath) { try { const data = JSON.parse(fs.readFileSync(pkgPath, "utf-8")); for (const key of ["module", "main"]) { const value = data[key]; if (typeof value === "string" && value.trim()) return path.resolve(path.dirname(pkgPath), value); } } catch {} return null; }
function resolveImportCandidate(base) { const candidates = [base]; if (!path.extname(base)) candidates.push(...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"].map((ext) => base + ext)); for (const candidate of candidates) { try { const st = fs.lstatSync(candidate); if (st.isSymbolicLink() || st.isFile()) return candidate; } catch {} } try { const st = fs.lstatSync(base); if (st.isSymbolicLink()) return base; if (st.isDirectory()) { const pkgEntry = packageJsonEntry(path.join(base, "package.json")); if (pkgEntry) { const resolved = resolveImportCandidate(pkgEntry); if (resolved) return resolved; } for (const name of ["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.mjs", "index.cjs", "index.json"]) { const resolved = resolveImportCandidate(path.join(base, name)); if (resolved) return resolved; } } } catch {} return null; }
function packageImportBase(specifier) { const parts = String(specifier).split("/"); const packageName = String(specifier).startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] || ""; const subpath = String(specifier).startsWith("@") ? parts.slice(2) : parts.slice(1); return path.join(sourceRootReal, "node_modules", packageName, ...subpath); }
function isPackageSpecifier(specifier) { return !path.isAbsolute(specifier) && !String(specifier).startsWith(".") && !String(specifier).startsWith("/") && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier) && !isNodeBuiltinImport(specifier); }
function resolveConfinedImport(specifier, fromDir) { if (isDeniedProbeImport(specifier)) throw new ProbePreparationError("PROBE_CONFINEMENT_DENIED", "Pi extension discovery probe denied import of " + specifier + " during executable discovery."); if (isNodeBuiltinImport(specifier)) return null; if (!path.isAbsolute(specifier) && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) throw new ProbePreparationError("PROBE_FS_READ_DENIED", "Pi extension discovery refused to bundle URL import " + specifier + "."); const packageSpecifier = isPackageSpecifier(specifier); const base = (path.isAbsolute(specifier) || String(specifier).startsWith(".") || String(specifier).startsWith("/")) ? path.resolve(fromDir, specifier) : packageImportBase(specifier); if (!isPathInside(sourceRootReal, base)) throw new ProbePreparationError("PROBE_FS_READ_DENIED", "Pi extension discovery refused to resolve import " + specifier + " outside the extension source root."); const resolved = resolveImportCandidate(base); if (!resolved) { if (packageSpecifier) throw new ProbePreparationError("PROBE_FS_READ_DENIED", "Pi extension discovery refused to resolve package import " + specifier + " outside the extension source root. Only extension-local node_modules packages may be bundled."); throw new ProbePreparationError("probe_build_failed", "Pi extension discovery could not resolve import " + specifier + "."); } return assertRealPathInsideSource(resolved, "import " + specifier); }
function esbuildLoaderForPath(file) { const ext = path.extname(file).toLowerCase(); if (ext === ".json") return "json"; if (ext === ".tsx") return "tsx"; if ([".ts", ".mts", ".cts"].includes(ext)) return "ts"; return "js"; }
function fail(err) { preparationError = err; throw err; }
(async () => {
  try {
    const esbuild = require(esbuildPath);
    await esbuild.build({
      entryPoints: [entryPath],
      outfile: outFile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      logLevel: "silent",
      plugins: [{ name: "bobbit-pi-extension-bundle-confinement", setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => { try { const importerDir = args.importer ? path.dirname(args.importer) : path.dirname(path.resolve(entryPath)); const resolved = resolveConfinedImport(args.path, importerDir); if (!resolved) return { path: args.path, external: true }; return { path: resolved }; } catch (err) { if (err instanceof ProbePreparationError) return fail(err); throw err; } });
        build.onLoad({ filter: /.*/ }, (args) => { try { const real = assertRealPathInsideSource(args.path, "bundle load " + args.path); return { contents: fs.readFileSync(real, "utf-8"), loader: esbuildLoaderForPath(real), resolveDir: path.dirname(real) }; } catch (err) { if (err instanceof ProbePreparationError) return fail(err); throw err; } });
      }}],
    });
  } catch (err) {
    const prepared = preparationError instanceof ProbePreparationError ? preparationError : new ProbePreparationError("probe_build_failed", sanitizeMessage(err));
    process.stderr.write(JSON.stringify({ code: prepared.code, message: prepared.message }));
    process.exit(1);
  }
})();
`;
}

function bundleTypeScriptEntryWithEsbuild(entryPath: string, outFile: string): boolean {
	let esbuildPath: string;
	try {
		esbuildPath = require.resolve("esbuild");
	} catch {
		return false;
	}
	const sourceRootReal = fs.realpathSync(inferAllowedSourceRoot(entryPath));
	const workerPath = path.join(path.dirname(outFile), "bundle-worker.cjs");
	fs.writeFileSync(workerPath, typeScriptBundleWorkerScript(), "utf-8");
	const result = spawnSync(process.execPath, [workerPath, entryPath, outFile, sourceRootReal, esbuildPath], {
		cwd: path.dirname(outFile),
		env: minimalEnv(),
		encoding: "utf-8",
		windowsHide: true,
		timeout: DEFAULT_TIMEOUT_MS,
		maxBuffer: MAX_OUTPUT_BYTES,
	});
	if (result.status === 0 && fs.existsSync(outFile)) return true;
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
		throw new ProbePreparationError("probe_timeout", `Pi extension discovery TypeScript bundling timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
	}
	try {
		const parsed = JSON.parse(String(result.stderr || "").trim()) as { code?: string; message?: string };
		if (parsed?.code) throw new ProbePreparationError(parsed.code, parsed.message || "Pi extension discovery TypeScript bundling failed.");
	} catch (err) {
		if (err instanceof ProbePreparationError) throw err;
	}
	throw new ProbePreparationError("probe_build_failed", sanitizeMessage(result.stderr || result.stdout || result.error || "Pi extension discovery TypeScript bundling failed."));
}

function transpileTypeScriptEntry(entryPath: string, outFile: string): void {
	// Prefer esbuild when present because it deterministically bundles local .ts
	// helpers into the temp probe entry. Production builds may not include a TS
	// loader, so discovery cannot rely on parent process --import/tsx hooks.
	try {
		assertTypeScriptBundleConfined(entryPath);
		if (bundleTypeScriptEntryWithEsbuild(entryPath, outFile)) return;
	} catch (err) {
		if (err instanceof ProbePreparationError) throw err;
		// Fall through to TypeScript's emitter (if installed) and finally a small
		// syntax-stripping fallback for simple plain-pi extension.ts files.
	}
	const source = fs.readFileSync(entryPath, "utf-8");
	try {
		const ts = require("typescript") as typeof import("typescript");
		const moduleResolution = (ts.ModuleResolutionKind as any).Bundler
			?? (ts.ModuleResolutionKind as any).Node10
			?? (ts.ModuleResolutionKind as any).NodeJs;
		const result = ts.transpileModule(source, {
			// The probe entry is written as .mjs. Do not let NodeNext resolution infer
			// CommonJS from an extension.ts file living in a pack without package.json
			// "type":"module"; that emits `exports.default = ...` into entry.mjs.
			fileName: entryPath.replace(/\.tsx?$/i, ".mts"),
			compilerOptions: {
				module: (ts.ModuleKind as any).ES2022 ?? ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2022,
				esModuleInterop: true,
				allowSyntheticDefaultImports: true,
				isolatedModules: true,
				moduleResolution,
			},
		});
		if (/Object\.defineProperty\(exports,\s*["']__esModule/.test(result.outputText) || /^\s*exports\./m.test(result.outputText) || /\bmodule\.exports\s*=/.test(result.outputText)) {
			throw new Error("TypeScript fallback produced CommonJS output for an ESM probe entry.");
		}
		fs.writeFileSync(outFile, result.outputText, "utf-8");
		return;
	} catch {
		const stripped = source
			.replace(/^\s*interface\s+\w+[\s\S]*?^}\s*$/gm, "")
			.replace(/^\s*type\s+\w+[\s\S]*?;\s*$/gm, "")
			.replace(/\s+as\s+[A-Za-z_$][\w$<>,\s\[\]{}|&?:.]*/g, "")
			.replace(/(:\s*[A-Za-z_$][\w$<>,\s\[\]{}|&?:.]*)\s*(?=[,)=;])/g, "");
		fs.writeFileSync(outFile, stripped, "utf-8");
	}
}

function prepareProbeEntry(entryPath: string, tempRoot: string): string {
	if (path.extname(entryPath).toLowerCase() !== ".ts") return entryPath;
	const outFile = path.join(tempRoot, "entry.mjs");
	transpileTypeScriptEntry(entryPath, outFile);
	return outFile;
}

function inferAllowedSourceRoot(entryPath: string): string {
	const resolved = path.resolve(entryPath);
	const parts = resolved.split(path.sep);
	const idx = parts.lastIndexOf("pi-extensions");
	if (idx >= 0 && idx + 2 < parts.length) return path.resolve(parts.slice(0, idx + 2).join(path.sep) || path.parse(resolved).root);
	return path.dirname(resolved);
}

function confinementCore(allowedRoots: readonly string[], cjs = true): string {
	const header = cjs
		? 'const path = require("node:path");\nconst { fileURLToPath } = require("node:url");\n'
		: 'import path from "node:path";\nimport { fileURLToPath } from "node:url";\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n';
	return `${header}
const nativeFs = require("node:fs");
const allowedRoots = ${JSON.stringify(allowedRoots)}.map((root) => norm(root));
const followReadOps = new Set(["access", "accessSync", "exists", "existsSync", "stat", "statSync", "realpath", "realpathSync", "readFile", "readFileSync", "readdir", "readdirSync", "createReadStream", "opendir", "opendirSync"]);
const symlinkMetadataReadOps = new Set(["lstat", "lstatSync", "readlink", "readlinkSync"]);
const mutatingOps = new Set(["appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "fchmod", "fchmodSync", "fchown", "fchownSync", "fdatasync", "fdatasyncSync", "ftruncate", "ftruncateSync", "futimes", "futimesSync", "link", "linkSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "write", "writeSync", "writeFile", "writeFileSync"]);
const fileHandleReadOps = new Set(["close", "read", "readFile", "stat"]);
const fileHandleMutatingOps = new Set(["appendFile", "chmod", "chown", "datasync", "sync", "truncate", "utimes", "write", "writeFile"]);
function norm(value) { return path.resolve(value); }
function toPath(value) { if (value == null || typeof value === "number") return null; if (value instanceof URL) return fileURLToPath(value); return path.resolve(String(value)); }
function insideResolved(resolved) { return allowedRoots.some((root) => { const rel = path.relative(root, resolved); return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)); }); }
function err(code, message) { const e = new Error(message); e.code = code; return e; }
function readDenied(op) { return err("PROBE_FS_READ_DENIED", "Pi extension discovery probe denied " + op + " outside the extension source root."); }
function assertLexicalRead(value, op) { const raw = toPath(value); if (!raw) return; if (!insideResolved(norm(raw))) throw readDenied(op); }
function assertFollowRead(value, op) { const raw = toPath(value); if (!raw) return; const resolved = norm(raw); if (!insideResolved(resolved)) throw readDenied(op); let real; try { real = nativeFs.realpathSync(resolved); } catch (e) { const code = e && typeof e === "object" && "code" in e ? e.code : undefined; if (code === "ENOENT" || code === "ENOTDIR") return; throw e; } if (!insideResolved(norm(real))) throw readDenied(op); }
function assertRead(value, op) { assertFollowRead(value, op); }
function denyWrite(op) { throw err("PROBE_FS_WRITE_DENIED", "Pi extension discovery probe denied mutating filesystem operation " + op + ". Discovery is best-effort and uses read-only source access."); }
function denyFsApi(op) { throw err("PROBE_FS_API_DENIED", "Pi extension discovery probe denied unaudited filesystem API " + op + ". Discovery only allows audited read-only filesystem operations."); }
function denyBuiltin(request) { throw err("PROBE_CONFINEMENT_DENIED", "Pi extension discovery probe denied import of " + request + " during executable discovery."); }
function isReadOnlyOpenFlag(flags, fsObj) { if (flags == null) return true; if (["r", "rs", "sr"].includes(flags)) return true; if (typeof flags !== "number") return false; const c = fsObj && fsObj.constants ? fsObj.constants : {}; const writeMask = (c.O_WRONLY ?? 1) | (c.O_RDWR ?? 2) | (c.O_CREAT ?? 64) | (c.O_TRUNC ?? 512) | (c.O_APPEND ?? 1024); return (flags & writeMask) === 0; }
function wrapFileHandle(handle, label) { if (!handle || typeof handle !== "object") return handle; return new Proxy(handle, { get(target, prop, receiver) { const value = Reflect.get(target, prop, receiver); if (typeof prop !== "string" || typeof value !== "function") return value; if (fileHandleMutatingOps.has(prop)) return function() { denyWrite(label + ".FileHandle." + prop); }; if (fileHandleReadOps.has(prop)) return value.bind(target); return function() { denyFsApi(label + ".FileHandle." + prop); }; }}); }
function wrapOpenResult(result, label) { if (result && typeof result.then === "function") return result.then((handle) => wrapFileHandle(handle, label)); return wrapFileHandle(result, label); }
function wrapFs(realFs, label) { return new Proxy(realFs, { get(target, prop, receiver) { if (prop === "promises" && target.promises) return wrapFs(target.promises, label + ".promises"); const value = Reflect.get(target, prop, receiver); if (typeof prop !== "string" || typeof value !== "function") return value; if (prop === "open" || prop === "openSync") return function(file, flags, ...rest) { assertFollowRead(file, label + "." + prop); if (!isReadOnlyOpenFlag(flags, target)) denyWrite(label + "." + prop); return wrapOpenResult(value.call(target, file, flags, ...rest), label); }; if (mutatingOps.has(prop)) return function() { denyWrite(label + "." + prop); }; if (symlinkMetadataReadOps.has(prop)) return function(file, ...rest) { assertLexicalRead(file, label + "." + prop); return value.call(target, file, ...rest); }; if (followReadOps.has(prop)) return function(file, ...rest) { assertFollowRead(file, label + "." + prop); return value.call(target, file, ...rest); }; return function() { denyFsApi(label + "." + prop); }; }}); }
`;
}

function writeProbeConfinementFiles(tempRoot: string, entryPath: string): { preloadPath: string; loaderPath: string } {
	const allowedRoots = [inferAllowedSourceRoot(entryPath), tempRoot].map((root) => fs.realpathSync(root));
	const preloadPath = path.join(tempRoot, "confinement-preload.cjs");
	const loaderPath = path.join(tempRoot, "confinement-loader.mjs");
	const fsShimPath = path.join(tempRoot, "fs-shim.mjs");
	const fsPromisesShimPath = path.join(tempRoot, "fs-promises-shim.mjs");
	const denied = JSON.stringify(DENIED_PROBE_IMPORTS);
	fs.writeFileSync(preloadPath, `${confinementCore(allowedRoots)}
const Module = require("node:module");
const fsShim = wrapFs(require("node:fs"), "fs");
const fsPromisesShim = wrapFs(require("node:fs/promises"), "fs.promises");
const denied = new Set(${denied});
function isDeniedImport(request) { const normalized = String(request || "").replace(/^node:/, ""); return Array.from(denied).some((value) => normalized === value || normalized.startsWith(value + "/")); }
function denyNetworkGlobal(name) { const blocked = function blockedPiExtensionDiscoveryNetworkGlobal() { throw err("PROBE_CONFINEMENT_DENIED", "Pi extension discovery probe denied global " + name + " during executable discovery."); }; try { Object.defineProperty(globalThis, name, { value: blocked, writable: false, configurable: false }); } catch { try { globalThis[name] = blocked; } catch {} } }
for (const name of ["fetch", "WebSocket", "EventSource", "Request", "Response", "Headers", "FormData"]) { if (name in globalThis) denyNetworkGlobal(name); }
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) { const normalized = String(request || "").replace(/^node:/, ""); if (normalized === "fs") return fsShim; if (normalized === "fs/promises") return fsPromisesShim; if (isDeniedImport(request)) denyBuiltin(request); if (!String(request || "").startsWith("node:")) { try { const resolved = Module._resolveFilename(request, parent, isMain); if (typeof resolved === "string" && path.isAbsolute(resolved)) assertRead(resolved, "module import"); } catch (e) { if (e && (e.code === "PROBE_FS_READ_DENIED" || e.code === "PROBE_CONFINEMENT_DENIED")) throw e; } } return originalLoad.apply(this, arguments); };
// Best-effort in-process confinement for trusted discovery: this blocks normal
// JS writes, network-capable globals, and dangerous imports, but is not OS/container isolation.
`, "utf-8");
	const fsShimCore = confinementCore(allowedRoots, false);
	fs.writeFileSync(fsShimPath, `${fsShimCore}
import realFs from "node:fs";
const fs = wrapFs(realFs, "fs");
export default fs;
export const constants = realFs.constants;
export const promises = wrapFs(realFs.promises, "fs.promises");
export const access = fs.access, accessSync = fs.accessSync, existsSync = fs.existsSync, lstat = fs.lstat, lstatSync = fs.lstatSync, opendir = fs.opendir, opendirSync = fs.opendirSync, open = fs.open, openSync = fs.openSync, readdir = fs.readdir, readdirSync = fs.readdirSync, readFile = fs.readFile, readFileSync = fs.readFileSync, readlink = fs.readlink, readlinkSync = fs.readlinkSync, realpath = fs.realpath, realpathSync = fs.realpathSync, stat = fs.stat, statSync = fs.statSync, createReadStream = fs.createReadStream, createWriteStream = fs.createWriteStream, writeFile = fs.writeFile, writeFileSync = fs.writeFileSync, rm = fs.rm, rmSync = fs.rmSync, mkdir = fs.mkdir, mkdirSync = fs.mkdirSync, cp = fs.cp, cpSync = fs.cpSync;
`, "utf-8");
	fs.writeFileSync(fsPromisesShimPath, `${fsShimCore}
import realFs from "node:fs/promises";
const fs = wrapFs(realFs, "fs.promises");
export default fs;
export const constants = realFs.constants;
export const access = fs.access, lstat = fs.lstat, opendir = fs.opendir, open = fs.open, readdir = fs.readdir, readFile = fs.readFile, readlink = fs.readlink, realpath = fs.realpath, stat = fs.stat, writeFile = fs.writeFile, rm = fs.rm, mkdir = fs.mkdir, cp = fs.cp;
`, "utf-8");
	const fsShimUrl = pathToFileUrlString(fsShimPath);
	const fsPromisesShimUrl = pathToFileUrlString(fsPromisesShimPath);
	fs.writeFileSync(loaderPath, `import fs from "node:fs";\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst fsShimUrl = ${JSON.stringify(fsShimUrl)};\nconst fsPromisesShimUrl = ${JSON.stringify(fsPromisesShimUrl)};\nconst allowedRoots = ${JSON.stringify(allowedRoots)}.map((root) => path.resolve(root));\nconst denied = new Set(${denied});\nfunction fail(code, message) { const e = new Error(message); e.code = code; throw e; }\nfunction deny(specifier) { fail("PROBE_CONFINEMENT_DENIED", "Pi extension discovery probe denied import of " + specifier + " during executable discovery."); }\nfunction isDeniedImport(specifier) { const normalized = String(specifier || "").replace(/^node:/, ""); return Array.from(denied).some((value) => normalized === value || normalized.startsWith(value + "/")); }\nfunction insideResolved(resolved) { return allowedRoots.some((root) => { const rel = path.relative(root, resolved); return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)); }); }\nfunction assertResolvedUrl(url) { if (!url.startsWith("file:")) return; const resolved = path.resolve(fileURLToPath(url)); if (!insideResolved(resolved)) fail("PROBE_FS_READ_DENIED", "Pi extension discovery probe denied module import outside the extension source root."); let real; try { real = fs.realpathSync(resolved); } catch (e) { const code = e && typeof e === "object" && "code" in e ? e.code : undefined; if (code === "ENOENT" || code === "ENOTDIR") return; throw e; } if (!insideResolved(path.resolve(real))) fail("PROBE_FS_READ_DENIED", "Pi extension discovery probe denied module import outside the extension source root."); }\nexport async function resolve(specifier, context, nextResolve) { if (context.parentURL === fsShimUrl || context.parentURL === fsPromisesShimUrl) return nextResolve(specifier, context); const normalized = String(specifier || "").replace(/^node:/, ""); if (normalized === "fs") return { url: fsShimUrl, shortCircuit: true }; if (normalized === "fs/promises") return { url: fsPromisesShimUrl, shortCircuit: true }; if (isDeniedImport(specifier)) deny(specifier); const resolved = await nextResolve(specifier, context); assertResolvedUrl(resolved.url); return resolved; }\n`, "utf-8");
	return { preloadPath, loaderPath };
}

function pathToFileUrlString(file: string): string {
	return pathToFileURL(path.resolve(file)).href;
}

function probeScript(): string {
	return `
import { pathToFileURL } from "node:url";
const MARKER = ${JSON.stringify(RESULT_MARKER)};
const tools = [];
const seen = new Set();
function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function pickSchema(v) {
  if (!isObj(v)) return undefined;
  for (const key of ["inputSchema", "schema", "parameters", "args", "argsSchema"]) {
    if (isObj(v[key])) return v[key];
  }
  return undefined;
}
function recordTool(...args) {
  let name;
  let description;
  let inputSchema;
  const first = args[0];
  const second = args[1];
  const third = args[2];
  if (typeof first === "string") {
    name = first;
    if (typeof second === "string") description = second;
    if (isObj(second)) {
      if (typeof second.description === "string") description = second.description;
      inputSchema = pickSchema(second);
    }
    if (!inputSchema && isObj(third)) inputSchema = pickSchema(third);
  } else if (isObj(first)) {
    if (typeof first.name === "string") name = first.name;
    else if (typeof first.id === "string") name = first.id;
    if (typeof first.description === "string") description = first.description;
    inputSchema = pickSchema(first);
  }
  if (!name || seen.has(name)) return;
  seen.add(name);
  const tool = { name };
  if (description) tool.description = description;
  if (inputSchema) tool.inputSchema = inputSchema;
  tools.push(tool);
}
const noOp = () => undefined;
const registrar = (...args) => { recordTool(...args); return undefined; };
const toolsApi = new Proxy({}, { get(_target, prop) {
  if (["register", "registerTool", "tool", "add", "addTool", "define", "create"].includes(String(prop))) return registrar;
  return noOp;
}});
const pi = new Proxy({
  registerTool: registrar,
  tool: registrar,
  addTool: registrar,
  register: registrar,
  defineTool: registrar,
  tools: toolsApi,
  on: noOp,
  once: noOp,
  off: noOp,
  emit: noOp,
  log: { debug: noOp, info: noOp, warn: noOp, error: noOp },
}, { get(target, prop) {
  if (prop in target) return target[prop];
  if (String(prop).toLowerCase().includes("tool") || String(prop).toLowerCase().includes("register")) return registrar;
  return noOp;
}});
globalThis.pi = pi;
try {
  const entry = process.argv[2];
  const mod = await import(pathToFileURL(entry).href);
  let activate = typeof mod.default === "function" ? mod.default : undefined;
  if (!activate && mod.default && typeof mod.default.activate === "function") activate = mod.default.activate.bind(mod.default);
  if (!activate && typeof mod.activate === "function") activate = mod.activate;
  if (!activate && typeof mod.register === "function") activate = mod.register;
  if (!activate && typeof mod.extension === "function") activate = mod.extension;
  if (activate) await activate(pi);
  console.log(MARKER + JSON.stringify({ status: "ok", tools }));
} catch (err) {
  const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "probe_failed";
  console.log(MARKER + JSON.stringify({ status: "failed", code, message }));
}
`;
}

function interpretProbeResult(
	result: PiExtensionDiscoveryProbeResult,
	timeoutMs: number,
	cacheKey?: string,
): PiExtensionDiscoveryResult {
	if (result.timedOut) return failed("probe_timeout", `Pi extension discovery timed out after ${timeoutMs}ms.`, cacheKey);
	const parsed = parseProbeResult(result.stdout);
	if (!parsed) {
		if (isUnsettledTopLevelAwaitOutput(result.stderr || result.stdout)) return failed("probe_timeout", `Pi extension discovery timed out after ${timeoutMs}ms.`, cacheKey);
		const stderr = sanitizeMessage(result.stderr || result.stdout || `probe exited with code ${result.exitCode ?? "unknown"}`);
		return failed("probe_invalid_output", `Pi extension discovery did not return a valid result: ${stderr}`, cacheKey);
	}
	if (parsed.status === "failed") return failed(parsed.code || "probe_failed", parsed.message, cacheKey);
	return ok(parsed.tools, cacheKey);
}

function backendFailure(err: unknown, cacheKey?: string): PiExtensionDiscoveryResult {
	if (err instanceof ProbePreparationError) return failed(err.code, sanitizeMessage(err.message), cacheKey);
	return failed("probe_build_failed", sanitizeMessage(err), cacheKey);
}

function realProbeRequest(request: PiExtensionDiscoveryProbeRequest, sync: true): PiExtensionDiscoveryProbeResult;
function realProbeRequest(request: PiExtensionDiscoveryProbeRequest, sync: false): Promise<PiExtensionDiscoveryProbeResult>;
function realProbeRequest(request: PiExtensionDiscoveryProbeRequest, sync: boolean): PiExtensionDiscoveryProbeResult | Promise<PiExtensionDiscoveryProbeResult> {
	const tempRoot = request.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-ext-probe-"));
	const createdTemp = !request.cwd;
	let asyncCleanupAttached = false;
	try {
		fs.mkdirSync(tempRoot, { recursive: true });
		const probePath = path.join(tempRoot, "probe.mjs");
		fs.writeFileSync(probePath, probeScript(), "utf-8");
		const confinement = writeProbeConfinementFiles(tempRoot, request.entryPath);
		const preparedEntryPath = prepareProbeEntry(request.entryPath, tempRoot);
		if (sync) return runProbeSync(probePath, preparedEntryPath, tempRoot, request.timeoutMs, confinement);
		const pending = runProbe(probePath, preparedEntryPath, tempRoot, request.timeoutMs, confinement);
		asyncCleanupAttached = true;
		return pending.finally(() => {
				if (createdTemp) {
					try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
				}
			});
	} finally {
		// Async cleanup is attached only after all synchronous preparation succeeds.
		if (createdTemp && !asyncCleanupAttached) {
			try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}
}

export const realPiExtensionDiscoveryBackend: PiExtensionDiscoveryBackend = {
	run: (request) => realProbeRequest(request, false),
	runSync: (request) => realProbeRequest(request, true),
};

function discoveryRequest(entryPath: string, opts: DiscoverPiExtensionToolsOptions): PiExtensionDiscoveryProbeRequest {
	return {
		entryPath,
		timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
	};
}

function discoveryPreflight(entryPath: string, opts: DiscoverPiExtensionToolsOptions): { cacheKey?: string; result?: PiExtensionDiscoveryResult } {
	const cache = computePiExtensionDiscoveryCacheKeyWithDiagnostics(entryPath);
	if (cache.diagnostic) return { cacheKey: cache.cacheKey, result: failed(cache.diagnostic.code, cache.diagnostic.message, cache.cacheKey) };
	const cacheKey = cache.cacheKey;
	if (!opts.trustAccepted) return { cacheKey, result: skipped(cacheKey) };
	const st = (() => {
		try { return fs.statSync(entryPath); } catch { return null; }
	})();
	if (!st?.isFile()) return { cacheKey, result: failed("entry_not_found", `Pi extension entry does not exist or is not a file: ${entryPath}`, cacheKey) };
	return { cacheKey };
}

export async function discoverPiExtensionTools(entryPath: string, opts: DiscoverPiExtensionToolsOptions): Promise<PiExtensionDiscoveryResult> {
	const preflight = discoveryPreflight(entryPath, opts);
	if (preflight.result) return preflight.result;
	const request = discoveryRequest(entryPath, opts);
	try {
		const result = await (opts.backend ?? realPiExtensionDiscoveryBackend).run(request);
		return interpretProbeResult(result, request.timeoutMs, preflight.cacheKey);
	} catch (err) {
		return backendFailure(err, preflight.cacheKey);
	}
}

export function discoverPiExtensionToolsSync(entryPath: string, opts: DiscoverPiExtensionToolsOptions): PiExtensionDiscoveryResult {
	const preflight = discoveryPreflight(entryPath, opts);
	if (preflight.result) return preflight.result;
	const request = discoveryRequest(entryPath, opts);
	try {
		const result = (opts.backend ?? realPiExtensionDiscoveryBackend).runSync(request);
		return interpretProbeResult(result, request.timeoutMs, preflight.cacheKey);
	} catch (err) {
		return backendFailure(err, preflight.cacheKey);
	}
}

function probeNodeArgs(probePath: string, entryPath: string, confinement: { preloadPath: string; loaderPath: string }): string[] {
	const args = [...safeExecArgv(process.execArgv)];
	if (process.allowedNodeEnvironmentFlags?.has("--no-experimental-fetch")) args.push("--no-experimental-fetch");
	return [...args, "--require", confinement.preloadPath, "--experimental-loader", pathToFileUrlString(confinement.loaderPath), probePath, entryPath];
}

function runProbeSync(probePath: string, entryPath: string, cwd: string, timeoutMs: number, confinement: { preloadPath: string; loaderPath: string }): { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean } {
	const result = spawnSync(process.execPath, probeNodeArgs(probePath, entryPath, confinement), {
		cwd,
		env: minimalEnv(),
		encoding: "utf-8",
		windowsHide: true,
		timeout: timeoutMs,
		maxBuffer: MAX_OUTPUT_BYTES,
	});
	const stdout = String(result.stdout ?? "").slice(-MAX_OUTPUT_BYTES);
	let stderr = String(result.stderr ?? "").slice(-MAX_OUTPUT_BYTES);
	if (result.error) stderr = boundedAppend(stderr, Buffer.from(sanitizeMessage(result.error)));
	const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
	return { stdout, stderr, exitCode: result.status, timedOut };
}

function runProbe(probePath: string, entryPath: string, cwd: string, timeoutMs: number, confinement: { preloadPath: string; loaderPath: string }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let done = false;
		let timedOut = false;
		const child = spawn(process.execPath, probeNodeArgs(probePath, entryPath, confinement), {
			cwd,
			env: minimalEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		const finish = (exitCode: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				try { child.kill("SIGKILL"); } catch { /* ignore */ }
			}
			finish(null);
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });
		child.on("error", (err) => {
			stderr = boundedAppend(stderr, Buffer.from(sanitizeMessage(err)));
			finish(null);
		});
		child.on("exit", (code) => finish(code));
	});
}
