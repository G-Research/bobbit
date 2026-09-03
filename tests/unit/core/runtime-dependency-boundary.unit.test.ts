import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DEV_ONLY_BUNDLED_PACKAGES = [
	"@mariozechner/mini-lit",
	"@recogito/text-annotator",
	"@xterm/addon-fit",
	"@xterm/xterm",
	"lucide",
	"qrcode",
	"sortablejs",
] as const;
const RUNTIME_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@homebridge/node-pty-prebuilt-multiarch",
	"@lmstudio/sdk",
	"@sinclair/typebox",
	"acme-client",
	"better-sqlite3",
	"docx-preview",
	"flexsearch",
	"jsonc-parser",
	"jszip",
	"lit",
	"marked",
	"mkcert",
	"ollama",
	"pdfjs-dist",
	"typebox",
	"ws",
	"yaml",
] as const;

type Manifest = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};
type Lockfile = {
	packages?: Record<string, Manifest & { dev?: boolean }>;
};

function filesBelow(root: string, predicate: (path: string) => boolean): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && predicate(path)) files.push(path);
		}
	};
	visit(root);
	return files.sort();
}

function isCandidateSpecifier(specifier: string): boolean {
	return DEV_ONLY_BUNDLED_PACKAGES.some(name => specifier === name || specifier.startsWith(`${name}/`));
}

function executableModuleSpecifiers(path: string): string[] {
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const specifiers: string[] = [];
	const add = (node: ts.Expression | undefined): void => {
		if (node && ts.isStringLiteralLike(node) && isCandidateSpecifier(node.text)) specifiers.push(node.text);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const hasValueBinding = clause === undefined
				|| (!clause.isTypeOnly && (clause.name !== undefined
					|| (clause.namedBindings !== undefined && (ts.isNamespaceImport(clause.namedBindings)
						|| clause.namedBindings.elements.some(element => !element.isTypeOnly)))));
			if (hasValueBinding) add(node.moduleSpecifier);
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
			add(node.moduleSpecifier);
		} else if (ts.isCallExpression(node)) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === "require")) add(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return specifiers;
}

function candidateImports(paths: string[]): string[] {
	return paths.flatMap(path => executableModuleSpecifiers(path)
		.map(specifier => `${relative(REPO_ROOT, path).replaceAll("\\", "/")}: ${specifier}`));
}

describe("published runtime dependency boundary", () => {
	it("keeps bundled browser libraries dev-only in the manifest and lockfile", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Manifest;
		const lockfile = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8")) as Lockfile;
		const lockRoot = lockfile.packages?.[""];
		expect(lockRoot).toBeDefined();

		for (const name of DEV_ONLY_BUNDLED_PACKAGES) {
			expect(manifest.dependencies?.[name], `${name} must not ship as a runtime dependency`).toBeUndefined();
			expect(manifest.devDependencies?.[name], `${name} must remain available to UI and pack builds`).toBeTypeOf("string");
			expect(lockRoot?.dependencies?.[name], `${name} must be dev-only in the lock root`).toBeUndefined();
			expect(lockRoot?.devDependencies?.[name]).toBe(manifest.devDependencies?.[name]);
			expect(lockfile.packages?.[`node_modules/${name}`]?.dev, `${name} lock entry must be dev-only`).toBe(true);
		}
	});

	it("keeps every server, native, and deliberate pack external in production dependencies", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Manifest;
		expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([...RUNTIME_PACKAGES].sort());
		for (const name of RUNTIME_PACKAGES) expect(manifest.devDependencies?.[name]).toBeUndefined();
	});

	it("has no executable server or shared import of a dev-only browser package", () => {
		const sources = ["src/server", "src/shared"].flatMap(directory =>
			filesBelow(join(REPO_ROOT, directory), path => path.endsWith(".ts") && !path.endsWith(".d.ts")));
		expect(candidateImports(sources)).toEqual([]);
	});

	it("emits self-contained UI and shipped pack JavaScript for dev-only browser packages", () => {
		const roots = [join(REPO_ROOT, "dist", "ui"), join(REPO_ROOT, "dist", "server", "builtin-packs")];
		for (const root of roots) expect(existsSync(root), `run npm run build before checking ${relative(REPO_ROOT, root)}`).toBe(true);
		const outputs = roots.flatMap(root => filesBelow(root, path => /\.(?:js|mjs)$/.test(path)));
		expect(outputs.length).toBeGreaterThan(0);
		expect(candidateImports(outputs)).toEqual([]);
	});
});
