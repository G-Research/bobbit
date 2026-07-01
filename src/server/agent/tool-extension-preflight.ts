import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ToolProvider } from "./tool-manager.js";

export interface ToolExtensionDiagnostic {
	type: "invalid-tool-extension";
	severity: "error";
	code: "missing-extension" | "missing-local-import" | "module-load-failed";
	toolName: string;
	tool?: string;
	groupDir: string;
	group?: string;
	extensionPath: string;
	path?: string;
	sourcePath?: string;
	message: string;
	skipped: true;
}

export function isIgnoredToolGroupDir(name: string): boolean {
	if (name.startsWith(".")) return true;
	return /\.disabled(?:$|[-_])/.test(name);
}

function formatFsError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function isScriptFile(filePath: string): boolean {
	return /\.(?:[cm]?[jt]sx?)$/i.test(filePath);
}

function candidateFiles(candidate: string): string[] {
	const ext = path.extname(candidate);
	if (ext) {
		const base = candidate.slice(0, -ext.length);
		const aliases = ext === ".js"
			? [candidate, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`]
			: ext === ".mjs"
				? [candidate, `${base}.mts`, `${base}.ts`]
				: ext === ".cjs"
					? [candidate, `${base}.cts`, `${base}.ts`]
					: [candidate];
		return [...new Set(aliases)];
	}
	return [
		candidate,
		`${candidate}.ts`,
		`${candidate}.tsx`,
		`${candidate}.mts`,
		`${candidate}.cts`,
		`${candidate}.js`,
		`${candidate}.jsx`,
		`${candidate}.mjs`,
		`${candidate}.cjs`,
		`${candidate}.json`,
		path.join(candidate, "index.ts"),
		path.join(candidate, "index.tsx"),
		path.join(candidate, "index.mts"),
		path.join(candidate, "index.cts"),
		path.join(candidate, "index.js"),
		path.join(candidate, "index.jsx"),
		path.join(candidate, "index.mjs"),
		path.join(candidate, "index.cjs"),
	];
}

function resolveLocalImport(fromFile: string, specifier: string): string | undefined {
	const candidate = path.resolve(path.dirname(fromFile), specifier);
	for (const file of candidateFiles(candidate)) {
		try {
			if (fs.statSync(file).isFile()) return file;
		} catch { /* try next */ }
	}
	return undefined;
}

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

interface ImportSpecifier {
	specifier: string;
	typeOnly: boolean;
}

function importSpecifiers(source: string): ImportSpecifier[] {
	const specs: ImportSpecifier[] = [];
	const body = stripComments(source);
	const staticRe = /\b(import|export)\s+(type\s+)?(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']/g;
	let match: RegExpExecArray | null;
	while ((match = staticRe.exec(body))) {
		specs.push({ specifier: match[3], typeOnly: !!match[2] });
	}
	const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']/g;
	while ((match = dynamicRe.exec(body))) {
		specs.push({ specifier: match[1], typeOnly: false });
	}
	return specs;
}

const NODE_BUILTINS = new Set<string>([
	...builtinModules,
	...builtinModules.map((name) => `node:${name}`),
]);

function isNodeBuiltinSpecifier(specifier: string): boolean {
	if (NODE_BUILTINS.has(specifier)) return true;
	if (specifier.startsWith("node:")) return NODE_BUILTINS.has(specifier.slice(5));
	const [head] = specifier.split("/");
	return NODE_BUILTINS.has(head);
}

function isRelativeSpecifier(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

interface ImportGraphError {
	code: ToolExtensionDiagnostic["code"];
	message: string;
}

function validateImportGraph(entryPath: string): ImportGraphError | undefined {
	const seen = new Set<string>();
	const stack = [entryPath];
	while (stack.length > 0) {
		const file = stack.pop()!;
		const resolvedFile = path.resolve(file);
		if (seen.has(resolvedFile)) continue;
		seen.add(resolvedFile);

		let raw: string;
		try {
			raw = fs.readFileSync(resolvedFile, "utf-8");
		} catch (err) {
			return { code: "module-load-failed", message: `cannot read ${resolvedFile}: ${formatFsError(err)}` };
		}

		if (!isScriptFile(resolvedFile)) continue;
		for (const { specifier, typeOnly } of importSpecifiers(raw)) {
			if (typeOnly) continue;
			if (isRelativeSpecifier(specifier)) {
				const child = resolveLocalImport(resolvedFile, specifier);
				if (!child) {
					return { code: "missing-local-import", message: `missing local import ${JSON.stringify(specifier)} from ${resolvedFile}` };
				}
				if (isScriptFile(child)) stack.push(child);
				continue;
			}
			if (isNodeBuiltinSpecifier(specifier)) continue;
			try {
				createRequire(resolvedFile).resolve(specifier);
			} catch (localErr) {
				try {
					// Config-level tool groups are often copied into isolated project
					// directories without their own node_modules. Bare imports should
					// still resolve against Bobbit's installed dependencies, matching
					// how bundled tool extensions run from the app installation.
					createRequire(import.meta.url).resolve(specifier);
				} catch {
					return { code: "module-load-failed", message: `cannot resolve module import ${JSON.stringify(specifier)} from ${resolvedFile}: ${formatFsError(localErr)}` };
				}
			}
		}
	}
	return undefined;
}

const MODULE_LOAD_TIMEOUT_MS = 5_000;
const MODULE_LOAD_MAX_OUTPUT_BYTES = 64 * 1024;
const moduleLoadCache = new Map<string, { fingerprint: string; error?: string }>();

function sanitizeModuleLoadOutput(value: unknown): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

function bobbitInstallRoot(): string {
	const bobbitRequire = createRequire(import.meta.url);
	const esbuildPackageJson = bobbitRequire.resolve("esbuild/package.json");
	return path.dirname(path.dirname(path.dirname(esbuildPackageJson)));
}

function bundleForModuleLoadPreflight(extensionPath: string): string {
	// Bundle in the parent process, then import only the generated bundle in the
	// child process. This keeps executable preflight fast enough for startup while
	// still covering TypeScript config extensions and preserving copied overrides
	// that import Bobbit-installed dependencies (for example @sinclair/typebox).
	const bobbitRequire = createRequire(import.meta.url);
	const esbuild = bobbitRequire("esbuild") as typeof import("esbuild");
	const result = esbuild.buildSync({
		entryPoints: [extensionPath],
		bundle: true,
		write: false,
		platform: "node",
		format: "esm",
		target: "node20",
		logLevel: "silent",
		packages: "external",
	});
	const source = result.outputFiles?.[0]?.text;
	if (!source) throw new Error("esbuild produced no output");
	return source;
}

function moduleLoadPreflightScript(bundlePath: string): string {
	return `await import(${JSON.stringify(pathToFileURL(bundlePath).href)});`;
}

function moduleLoadFailure(extensionPath: string): string | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(extensionPath);
	} catch (err) {
		return `extension file cannot be loaded: ${extensionPath}: ${formatFsError(err)}`;
	}
	const fingerprint = `${extensionPath}:${stat.mtimeMs}:${stat.size}`;
	const cached = moduleLoadCache.get(extensionPath);
	if (cached?.fingerprint === fingerprint) return cached.error;

	let bundlePath: string | undefined;
	let result: ReturnType<typeof spawnSync>;
	try {
		bundlePath = path.join(bobbitInstallRoot(), `.bobbit-tool-preflight-${process.pid}-${Date.now()}.mjs`);
		fs.writeFileSync(bundlePath, bundleForModuleLoadPreflight(extensionPath), "utf-8");
		result = spawnSync(process.execPath, ["--input-type=module", "--eval", moduleLoadPreflightScript(bundlePath)], {
			cwd: path.dirname(extensionPath),
			env: { ...process.env, BOBBIT_TOOL_PREFLIGHT: "1" },
			encoding: "utf-8",
			windowsHide: true,
			timeout: MODULE_LOAD_TIMEOUT_MS,
			maxBuffer: MODULE_LOAD_MAX_OUTPUT_BYTES,
		});
	} catch (err) {
		return `module load failed: cannot prepare preflight: ${formatFsError(err)}`;
	} finally {
		if (bundlePath) {
			try { fs.rmSync(bundlePath, { force: true }); } catch { /* ignore */ }
		}
	}
	let error: string | undefined;
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
		error = `module load timed out after ${MODULE_LOAD_TIMEOUT_MS}ms`;
	} else if (result.error) {
		error = `module load failed: ${formatFsError(result.error)}`;
	} else if ((result.status ?? 0) !== 0) {
		error = `module load failed: ${sanitizeModuleLoadOutput(result.stderr || result.stdout || `exit ${result.status}`)}`;
	}
	moduleLoadCache.set(extensionPath, { fingerprint, error });
	return error;
}

function makeDiagnostic(input: { toolName: string; groupDir: string }, extensionPath: string, code: ToolExtensionDiagnostic["code"], message: string): ToolExtensionDiagnostic {
	return {
		type: "invalid-tool-extension",
		severity: "error",
		code,
		toolName: input.toolName,
		tool: input.toolName,
		groupDir: input.groupDir,
		group: input.groupDir,
		extensionPath,
		path: extensionPath,
		sourcePath: extensionPath,
		message,
		skipped: true,
	};
}

function preflightConfigExtensionPath(input: { toolName: string; groupDir: string }, extensionPath: string): ToolExtensionDiagnostic | undefined {
	try {
		if (!fs.statSync(extensionPath).isFile()) {
			return makeDiagnostic(input, extensionPath, "missing-extension", `extension file does not exist: ${extensionPath}`);
		}
	} catch (err) {
		return makeDiagnostic(input, extensionPath, "missing-extension", `extension file cannot be loaded: ${extensionPath}: ${formatFsError(err)}`);
	}

	const importError = validateImportGraph(extensionPath);
	if (importError) {
		return makeDiagnostic(input, extensionPath, importError.code, `${extensionPath}: ${importError.message}`);
	}
	const loadError = moduleLoadFailure(extensionPath);
	if (loadError) {
		return makeDiagnostic(input, extensionPath, "module-load-failed", `${extensionPath}: ${loadError}`);
	}
	return undefined;
}

export function preflightConfigExtensionFile(input: {
	toolName: string;
	groupDir: string;
	baseDir: string;
	extension: string;
}): ToolExtensionDiagnostic | undefined {
	return preflightConfigExtensionPath(
		{ toolName: input.toolName, groupDir: input.groupDir },
		path.resolve(input.baseDir, input.groupDir, input.extension),
	);
}

export function preflightConfigBobbitExtension(input: {
	toolName: string;
	groupDir: string;
	baseDir: string;
	provider?: ToolProvider;
}): ToolExtensionDiagnostic | undefined {
	if (input.provider?.type !== "bobbit-extension") return undefined;
	if (!input.provider.extension) {
		const extensionPath = path.join(input.baseDir, input.groupDir, "<missing>");
		return makeDiagnostic(
			input,
			extensionPath,
			"missing-extension",
			`bobbit-extension provider for ${input.toolName} does not declare an extension file`,
		);
	}

	return preflightConfigExtensionFile({
		toolName: input.toolName,
		groupDir: input.groupDir,
		baseDir: input.baseDir,
		extension: input.provider.extension,
	});
}

const loggedDiagnostics = new Set<string>();

export function logToolExtensionDiagnostic(diagnostic: ToolExtensionDiagnostic): void {
	const key = `${diagnostic.toolName}\0${diagnostic.extensionPath}\0${diagnostic.message}`;
	if (loggedDiagnostics.has(key)) return;
	loggedDiagnostics.add(key);
	console.warn(`[tool-manager] Invalid config tool override "${diagnostic.toolName}" in group "${diagnostic.groupDir}" skipped: ${diagnostic.message}`);
}

export function __resetToolExtensionPreflightDiagnostics(): void {
	loggedDiagnostics.clear();
	moduleLoadCache.clear();
}
