import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir as osTmpDir } from "node:os";
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

function moduleLoadPreflightLoaderScript(): string {
	// The child imports the original extension path (not a bundle) so bare package
	// resolution starts from the extension/project directory. The loader only fills
	// two gaps that Bobbit's runtime supports in practice: TS source files imported
	// through emitted .js specifiers, and copied config overrides that import a
	// Bobbit-installed dependency such as @sinclair/typebox.
	const bobbitModuleUrl = import.meta.url;
	return `
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const bobbitRequire = createRequire(${JSON.stringify(bobbitModuleUrl)});
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => "node:" + name)]);

function isRelativeSpecifier(specifier) {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

function isBareSpecifier(specifier) {
	return !isRelativeSpecifier(specifier) && !specifier.startsWith("/") && !specifier.match(/^[A-Za-z]:[\\\\/]/) && !specifier.startsWith("file:");
}

function isNodeBuiltinSpecifier(specifier) {
	if (nodeBuiltins.has(specifier)) return true;
	if (specifier.startsWith("node:")) return nodeBuiltins.has(specifier.slice(5));
	const [head] = specifier.split("/");
	return nodeBuiltins.has(head);
}

function candidateFiles(candidate) {
	const ext = path.extname(candidate);
	if (ext) {
		const base = candidate.slice(0, -ext.length);
		if (ext === ".js") return [candidate, base + ".ts", base + ".tsx", base + ".mts", base + ".cts", base + ".jsx", base + ".mjs", base + ".cjs"];
		if (ext === ".mjs") return [candidate, base + ".mts", base + ".ts"];
		if (ext === ".cjs") return [candidate, base + ".cts", base + ".ts"];
		return [candidate];
	}
	return [candidate, candidate + ".ts", candidate + ".tsx", candidate + ".mts", candidate + ".cts", candidate + ".js", candidate + ".jsx", candidate + ".mjs", candidate + ".cjs", candidate + ".json", path.join(candidate, "index.ts"), path.join(candidate, "index.tsx"), path.join(candidate, "index.mts"), path.join(candidate, "index.cts"), path.join(candidate, "index.js"), path.join(candidate, "index.jsx"), path.join(candidate, "index.mjs"), path.join(candidate, "index.cjs")];
}

function resolveLocalImport(parentUrl, specifier) {
	if (!parentUrl?.startsWith("file:")) return undefined;
	const parentPath = fileURLToPath(parentUrl);
	const candidate = path.resolve(path.dirname(parentPath), specifier);
	for (const file of candidateFiles(candidate)) {
		try {
			if (fs.statSync(file).isFile()) return pathToFileURL(file).href;
		} catch {}
	}
	return undefined;
}

export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (err) {
		if (isRelativeSpecifier(specifier)) {
			const localUrl = resolveLocalImport(context.parentURL, specifier);
			if (localUrl) return { url: localUrl, shortCircuit: true };
		}
		if (isBareSpecifier(specifier) && !isNodeBuiltinSpecifier(specifier)) {
			try {
				return { url: pathToFileURL(bobbitRequire.resolve(specifier)).href, shortCircuit: true };
			} catch {}
		}
		throw err;
	}
}
`;
}

function moduleLoadPreflightScript(extensionPath: string): string {
	return `await import(${JSON.stringify(pathToFileURL(extensionPath).href)});`;
}

export type ToolModuleLoadProbe = (extensionPath: string) => string | undefined;
let moduleLoadProbeForTesting: ToolModuleLoadProbe | undefined;

function realModuleLoadFailure(extensionPath: string): string | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(extensionPath);
	} catch (err) {
		return `extension file cannot be loaded: ${extensionPath}: ${formatFsError(err)}`;
	}
	const fingerprint = `${extensionPath}:${stat.mtimeMs}:${stat.size}`;
	const cached = moduleLoadCache.get(extensionPath);
	if (cached?.fingerprint === fingerprint) return cached.error;

	let tempDir: string | undefined;
	let result: ReturnType<typeof spawnSync>;
	try {
		tempDir = fs.mkdtempSync(path.join(osTmpDir(), "bobbit-tool-preflight-"));
		const loaderPath = path.join(tempDir, "loader.mjs");
		fs.writeFileSync(loaderPath, moduleLoadPreflightLoaderScript(), "utf-8");
		result = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", pathToFileURL(loaderPath).href, "--input-type=module", "--eval", moduleLoadPreflightScript(extensionPath)], {
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
		if (tempDir) {
			try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
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

function moduleLoadFailure(extensionPath: string): string | undefined {
	return (moduleLoadProbeForTesting ?? realModuleLoadFailure)(extensionPath);
}

/** Unit fixture seam; production always executes the confined child-process probe. */
export function __setToolModuleLoadProbeForTesting(probe: ToolModuleLoadProbe | undefined): void {
	moduleLoadProbeForTesting = probe;
	moduleLoadCache.clear();
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
