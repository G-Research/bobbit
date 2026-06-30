import fs from "node:fs";
import path from "node:path";

import type { ToolProvider } from "./tool-manager.js";

export interface ToolExtensionDiagnostic {
	type: "invalid-tool-extension";
	toolName: string;
	groupDir: string;
	extensionPath: string;
	message: string;
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

function localImportSpecifiers(source: string): string[] {
	const specs: string[] = [];
	const body = stripComments(source);
	const re = /(?:\bimport\s+(?:[^'"()]*?\s+from\s+)?|\bexport\s+(?:[^'"]*?\s+from\s+)|\bimport\s*\(\s*)["']([^"']+)["']/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(body))) {
		const spec = match[1];
		if (spec.startsWith("./") || spec.startsWith("../")) specs.push(spec);
	}
	return specs;
}

function validateImportGraph(entryPath: string): string | undefined {
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
			return `cannot read ${resolvedFile}: ${formatFsError(err)}`;
		}

		if (!isScriptFile(resolvedFile)) continue;
		for (const specifier of localImportSpecifiers(raw)) {
			const child = resolveLocalImport(resolvedFile, specifier);
			if (!child) {
				return `missing local import ${JSON.stringify(specifier)} from ${resolvedFile}`;
			}
			if (isScriptFile(child)) stack.push(child);
		}
	}
	return undefined;
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
		return {
			type: "invalid-tool-extension",
			toolName: input.toolName,
			groupDir: input.groupDir,
			extensionPath,
			message: `bobbit-extension provider for ${input.toolName} does not declare an extension file`,
		};
	}

	const extensionPath = path.resolve(input.baseDir, input.groupDir, input.provider.extension);
	try {
		if (!fs.statSync(extensionPath).isFile()) {
			return {
				type: "invalid-tool-extension",
				toolName: input.toolName,
				groupDir: input.groupDir,
				extensionPath,
				message: `extension file does not exist: ${extensionPath}`,
			};
		}
	} catch (err) {
		return {
			type: "invalid-tool-extension",
			toolName: input.toolName,
			groupDir: input.groupDir,
			extensionPath,
			message: `extension file cannot be loaded: ${extensionPath}: ${formatFsError(err)}`,
		};
	}

	const importError = validateImportGraph(extensionPath);
	if (importError) {
		return {
			type: "invalid-tool-extension",
			toolName: input.toolName,
			groupDir: input.groupDir,
			extensionPath,
			message: `${extensionPath}: ${importError}`,
		};
	}
	return undefined;
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
}
