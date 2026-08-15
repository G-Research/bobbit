import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	serializeLspRequest,
	sanitizeLspReason,
	type LspLanguageDeclaration,
	type LspRequestAdapterOptions,
	type LspRuntimeSnapshot,
} from "../../market-packs/code-intelligence/lib/lsp-request-adapter.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const typescript: LspLanguageDeclaration = {
	id: "typescript",
	label: "TypeScript",
	evidence: { globs: ["**/*.ts"] },
	lsp: {
		server: { id: "typescript-language-server", command: "typescript-language-server", args: ["--stdio"] },
		actions: ["definition", "references", "hover", "documentSymbols", "workspaceSymbols", "diagnostics"],
		host: [{ id: "typescript-language-server", label: "TypeScript Language Server", installHint: "Install typescript-language-server." }],
		sandbox: [],
	},
};

const layeredTypeScript: LspLanguageDeclaration = {
	...typescript,
	lsp: {
		...typescript.lsp!,
		host: [
			{ id: "node", label: "Node.js", installHint: "Install Node.js 20 or later." },
			{ id: "typescript-language-server", label: "TypeScript Language Server", installHint: "Install typescript-language-server." },
		],
		sandbox: [
			{ id: "node", layerId: "nodejs-20", label: "Node.js", installHint: "Add Node.js 20 or later to the project sandbox image." },
			{ id: "typescript-language-server", layerId: "tsls-layer", label: "TypeScript Language Server", installHint: "Add typescript-language-server to the project sandbox image." },
		],
	},
};

const structuralOnly: LspLanguageDeclaration = {
	id: "json",
	label: "JSON",
	evidence: { globs: ["**/*.json"] },
};

const go: LspLanguageDeclaration = {
	id: "go",
	label: "Go",
	evidence: { globs: ["**/*.go"] },
	lsp: {
		server: { id: "gopls", command: "gopls", args: [] },
		actions: ["workspaceSymbols"],
		host: [{
			id: "gopls",
			label: "gopls",
			installHint: "Install gopls with go install golang.org/x/tools/gopls@latest; see https://pkg.go.dev/golang.org/x/tools/gopls.",
		}],
		sandbox: [],
	},
};

function fixture(): { linkedRoot: string; primaryRoot: string; source: string; dispose: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-request-adapter-"));
	const primaryRoot = path.join(root, "primary", "api");
	const linkedRoot = path.join(root, "linked", "api");
	const source = path.join(linkedRoot, "src", "server.ts");
	fs.mkdirSync(path.dirname(source), { recursive: true });
	fs.mkdirSync(primaryRoot, { recursive: true });
	fs.writeFileSync(source, "export const answer = 42;\n");
	fs.writeFileSync(path.join(primaryRoot, "server.ts"), "export const primary = true;\n");
	return { linkedRoot, primaryRoot, source, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function options(root: string, runtime?: LspRuntimeSnapshot, languages: readonly LspLanguageDeclaration[] = [typescript, structuralOnly]): LspRequestAdapterOptions {
	return {
		context: {
			projectId: "project-42",
			component: { name: "api", repo: ".", relativePath: "services/api" },
			componentRoot: root,
		},
		languages,
		runtime,
	};
}

function definition(root: string, runtime?: LspRuntimeSnapshot) {
	return serializeLspRequest({
		action: "definition",
		path: "src/server.ts",
		position: { line: 0, character: 7 },
	}, options(root, runtime));
}

describe("LSP request adapter", () => {
	it("serializes a request at the canonical linked-worktree component root, never a primary checkout", () => {
		const f = fixture();
		try {
			const prepared = definition(f.linkedRoot);

			expect(prepared.result).toMatchObject({
				capability: "lsp",
				action: "definition",
				component: "api",
				languageId: "typescript",
				status: "unavailable",
				reasonCode: "service-unavailable",
			});
			expect(prepared.request).toMatchObject({
				key: {
					projectId: "project-42",
					component: { name: "api", repo: ".", relativePath: "services/api" },
					worktreePath: fs.realpathSync(f.linkedRoot),
					languageId: "typescript",
				},
				action: "definition",
				uri: pathToFileURL(fs.realpathSync(f.source)).href,
				position: { line: 0, character: 7 },
			});
			expect(JSON.stringify(prepared.request)).not.toContain(f.primaryRoot);
		} finally {
			f.dispose();
		}
	});

	it("rejects absolute, parent-traversal, and symlink paths before any service request", () => {
		const f = fixture();
		try {
			const outside = path.join(path.dirname(f.linkedRoot), "outside.ts");
			const link = path.join(f.linkedRoot, "src", "outside.ts");
			fs.writeFileSync(outside, "export const outside = true;\n");
			fs.symlinkSync(outside, link, "file");

			for (const input of ["../outside.ts", outside, "src/outside.ts", "src/missing.ts"]) {
				const prepared = serializeLspRequest({ action: "hover", path: input, position: { line: 0, character: 0 } }, options(f.linkedRoot));
				expect(prepared.result).toMatchObject({ status: "unavailable", reasonCode: "invalid-path" });
				expect(prepared.request).toBeUndefined();
			}
		} finally {
			f.dispose();
		}
	});

	it("rejects unknown components, invalid actions, action omissions, and invalid positions", () => {
		const f = fixture();
		try {
			const unavailableComponent = serializeLspRequest({
				action: "definition", component: "web", path: "src/server.ts", position: { line: 0, character: 0 },
			}, options(f.linkedRoot));
			expect(unavailableComponent.result).toMatchObject({ status: "unavailable", reasonCode: "component-unavailable" });

			const invalidAction = serializeLspRequest({ action: "rename" as any, path: "src/server.ts" }, options(f.linkedRoot));
			expect(invalidAction.result).toMatchObject({ action: "status", status: "unavailable", reasonCode: "invalid-request" });

			const unsupportedAction = serializeLspRequest({ action: "references", path: "src/server.ts", position: { line: 0, character: 0 } }, options(f.linkedRoot, undefined, [{ ...typescript, lsp: { ...typescript.lsp!, actions: ["definition"] } }]));
			expect(unsupportedAction.result).toMatchObject({ status: "unavailable", reasonCode: "unsupported-action", languageId: "typescript" });

			const invalidPosition = serializeLspRequest({ action: "definition", path: "src/server.ts", position: { line: -1, character: 0 } }, options(f.linkedRoot));
			expect(invalidPosition.result).toMatchObject({ status: "unavailable", reasonCode: "invalid-request" });
			expect(invalidPosition.request).toBeUndefined();
		} finally {
			f.dispose();
		}
	});

	it("canonicalizes the root for workspace/status actions and only forwards required positions", () => {
		const f = fixture();
		try {
			const workspace = serializeLspRequest({
				action: "workspaceSymbols", language: "typescript", query: "server", position: { line: 2, character: 3 },
			}, options(f.linkedRoot));
			expect(workspace.request).toMatchObject({ action: "workspaceSymbols", query: "server", key: { worktreePath: fs.realpathSync(f.linkedRoot) } });
			expect(workspace.request).not.toHaveProperty("uri");
			expect(workspace.request).not.toHaveProperty("position");

			const documentSymbols = serializeLspRequest({
				action: "documentSymbols", path: "src/server.ts", position: { line: 2, character: 3 },
			}, options(f.linkedRoot));
			expect(documentSymbols.request).not.toHaveProperty("position");

			const status = serializeLspRequest({ action: "status", language: "typescript" }, options(f.linkedRoot));
			expect(status.request).toBeUndefined();

			fs.rmSync(f.linkedRoot, { recursive: true, force: true });
			for (const input of [
				{ action: "workspaceSymbols" as const, language: "typescript", query: "server" },
				{ action: "status" as const, language: "typescript" },
			]) {
				const unavailable = serializeLspRequest(input, options(f.linkedRoot));
				expect(unavailable).toEqual({
					result: expect.objectContaining({ status: "unavailable", reasonCode: "component-unavailable", reason: "The linked-worktree component is unavailable." }),
				});
				expect(JSON.stringify(unavailable)).not.toContain(f.linkedRoot);
			}
		} finally {
			f.dispose();
		}
	});

	it("reports unsupported, disabled, missing-runtime, unavailable, and failed states truthfully", () => {
		const f = fixture();
		try {
			const unsupported = serializeLspRequest({ action: "diagnostics", language: "json", path: "data.json" }, options(f.linkedRoot));
			expect(unsupported.result).toMatchObject({ capability: "lsp", status: "unavailable", reasonCode: "unsupported-language", languageId: "json" });

			expect(definition(f.linkedRoot, { enabled: false }).result).toMatchObject({ status: "disabled", reasonCode: "disabled" });
			expect(definition(f.linkedRoot, { toolchain: "missing" }).result).toMatchObject({
				status: "requires-toolchain",
				reasonCode: "requires-toolchain",
				reason: "The LSP toolchain is unavailable, but the platform did not report validated missing requirement IDs and runtime.",
			});
			expect(definition(f.linkedRoot).result).toMatchObject({ status: "unavailable", reasonCode: "service-unavailable" });

			const failed = definition(f.linkedRoot, { service: "failed", reason: `${f.primaryRoot}/secret token=abc123\nconnection refused` });
			expect(failed.result).toMatchObject({ status: "failed", reasonCode: "service-failed" });
			expect(failed.result.reason).toContain("[redacted path]");
			expect(failed.result.reason).toContain("token=[redacted]");
			expect(failed.result.reason).not.toContain(f.primaryRoot);
		} finally {
			f.dispose();
		}
	});

	it("reports only platform-validated missing host or sandbox requirements", () => {
		const f = fixture();
		try {
			const host = serializeLspRequest({
				action: "definition", path: "src/server.ts", position: { line: 0, character: 0 },
			}, options(f.linkedRoot, {
				toolchain: "missing", runtime: "host", missingToolchainIds: ["typescript-language-server", "unrelated-tool"],
			}, [layeredTypeScript]));
			expect(host.result).toMatchObject({ status: "requires-toolchain", reasonCode: "requires-toolchain" });
			expect(host.result.reason).toBe("The host runtime is missing host requirement IDs: typescript-language-server. Install typescript-language-server.");
			expect(host.result.reason).not.toContain("node");

			const sandbox = serializeLspRequest({
				action: "definition", path: "src/server.ts", position: { line: 0, character: 0 },
			}, options(f.linkedRoot, {
				toolchain: "missing", runtime: "sandbox", missingToolchainIds: ["typescript-language-server"],
			}, [layeredTypeScript]));
			expect(sandbox.result.reason).toBe("The sandbox runtime is missing sandbox requirement IDs: typescript-language-server (layer tsls-layer). Add typescript-language-server to the project sandbox image.");

			const unmatched = serializeLspRequest({
				action: "definition", path: "src/server.ts", position: { line: 0, character: 0 },
			}, options(f.linkedRoot, {
				toolchain: "missing", runtime: "host", missingToolchainIds: ["unrelated-tool"],
			}, [layeredTypeScript]));
			expect(unmatched.result.reason).toBe("The host LSP toolchain is unavailable, but no reported missing ID matches a matrix-declared requirement.");
		} finally {
			f.dispose();
		}
	});

	it("preserves gopls install URLs while redacting absolute paths and secrets", () => {
		const f = fixture();
		try {
			const missing = serializeLspRequest({ action: "workspaceSymbols", language: "go", query: "handler" }, options(f.linkedRoot, {
				toolchain: "missing", runtime: "host", missingToolchainIds: ["gopls"],
			}, [go]));
			expect(missing.result.reason).toContain("go install golang.org/x/tools/gopls@latest");
			expect(missing.result.reason).toContain("https://pkg.go.dev/golang.org/x/tools/gopls");

			const reason = sanitizeLspReason("See https://pkg.go.dev/golang.org/x/tools/gopls after /private/worktree/gopls.log token=secret-value");
			expect(reason).toContain("https://pkg.go.dev/golang.org/x/tools/gopls");
			expect(reason).toContain("[redacted path]");
			expect(reason).toContain("token=[redacted]");
			expect(reason).not.toContain("/private/worktree");
			expect(reason).not.toContain("secret-value");
		} finally {
			f.dispose();
		}
	});

	it("bounds and sanitizes degradation text without exposing topology or secrets", () => {
		const raw = `/private/worktree/secrets.env password=hunter2 ${"x".repeat(1_000)}`;
		const reason = sanitizeLspReason(raw);
		expect(reason).toContain("[redacted path]");
		expect(reason).toContain("password=[redacted]");
		expect(reason).not.toContain("/private/worktree");
		expect(reason).not.toContain("hunter2");
		expect(reason.length).toBeLessThanOrEqual(240);
	});

	it("sanitizes Windows, UNC, bearer, and authorization runtime details", () => {
		const raw = "failed at C:\\Users\\Ada Lovelace\\private work\\server.ts Authorization: Bearer bearer-secret; UNC \\\\fileserver\\team share\\private repo\\server.ts; bearer another-secret";
		const reason = sanitizeLspReason(raw);
		expect(reason).toContain("[redacted path]");
		for (const sensitive of ["C:\\Users", "Ada Lovelace", "fileserver", "team share", "bearer-secret", "another-secret"]) {
			expect(reason).not.toContain(sensitive);
		}
		expect(reason).toContain("authorization=[redacted]");
		expect(reason).toContain("bearer [redacted]");
	});

	it("remains a pure serializer with no process spawn, private manager, or lifecycle map", () => {
		const source = fs.readFileSync(path.join(REPO_ROOT, "market-packs", "code-intelligence", "lib", "lsp-request-adapter.ts"), "utf8");
		for (const forbidden of ["node:child_process", "BgProcessManager", "spawn(", "exec(", "new Map(", "buildSandboxImage"]) {
			expect(source).not.toContain(forbidden);
		}
	});
});
