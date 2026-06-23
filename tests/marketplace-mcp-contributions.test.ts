/**
 * Unit — Marketplace MCP contribution loader.
 *
 * Pins strict validation and exact normalization for schema-2 pack-owned
 * mcp/<listName>.yaml|json contribution files.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PackManifest } from "../src/server/agent/pack-types.ts";
import {
	isSafeMcpListName,
	isValidMcpServerName,
	loadMcpContributions,
	loadPackContributions,
	mcpGeneratedPackNameForId,
	McpContributionValidationError,
	normalizeMcpContribution,
	PackContributionError,
} from "../src/server/agent/pack-contributions.ts";

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-mcp-contrib-")); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

function packRoot(caseName: string): string {
	const root = path.join(tmp, caseName, "market-packs", "mcp-pack");
	fs.mkdirSync(root, { recursive: true });
	return root;
}

function manifest(mcp: string[]): PackManifest {
	return {
		name: "mcp-pack",
		description: "d",
		version: "1",
		schema: 2,
		contents: {
			roles: [],
			tools: [],
			skills: [],
			entrypoints: [],
			providers: [],
			hooks: [],
			mcp,
			piExtensions: [],
			runtimes: [],
			workflows: [],
		},
	};
}

describe("Marketplace MCP contribution validation helpers", () => {
	it("validates strict list names, server names, and generated registry pack names", () => {
		for (const good of ["context7", "docs.remote", "docs_remote", "docs-remote", "a1"]) {
			assert.equal(isSafeMcpListName(good), true, `${good} should be a safe MCP listName`);
		}
		for (const bad of ["", ".hidden", "../x", "a/b", "a\\b", "with\0null", "con", "COM1", "a..b"]) {
			assert.equal(isSafeMcpListName(bad), false, `${JSON.stringify(bad)} should be rejected`);
		}

		for (const good of ["context7", "docs.remote", "docs_remote", "docs-remote", "A1"]) {
			assert.equal(isValidMcpServerName(good), true, `${good} should be a valid MCP server name`);
		}
		for (const bad of ["", ".hidden", "bad__sub", "a/b", "a\\b", "with\0null", ".", ".."] ) {
			assert.equal(isValidMcpServerName(bad), false, `${JSON.stringify(bad)} should be rejected`);
		}

		assert.equal(mcpGeneratedPackNameForId("context7"), "mcp-context7");
		assert.throws(() => mcpGeneratedPackNameForId("Docs"), McpContributionValidationError);
		assert.throws(() => mcpGeneratedPackNameForId("Docs.Remote"), McpContributionValidationError);
	});
});

describe("loadMcpContributions", () => {
	it("loads YAML stdio contributions and normalizes cwd to an absolute pack-contained path", () => {
		const root = packRoot("stdio-yaml");
		w(path.join(root, "server"), "marker\n");
		w(path.join(root, "mcp", "context7.yaml"), [
			"server: context7-runtime",
			"label: Context7",
			"description: Fetch library docs",
			"subNamespace: docs",
			"transport:",
			"  type: stdio",
			"  command: npx",
			"  args: ['-y', '@upstash/context7-mcp']",
			"  env:",
			"    CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}'",
			"  cwd: server",
			"",
		].join("\n"));

		const contributions = loadMcpContributions(root, manifest(["context7"]));
		assert.deepEqual(contributions, [{
			listName: "context7",
			serverName: "context7-runtime",
			config: {
				command: "npx",
				args: ["-y", "@upstash/context7-mcp"],
				env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
				cwd: path.join(root, "server"),
			},
			sourceFile: path.join(root, "mcp", "context7.yaml"),
			packRoot: root,
			label: "Context7",
			description: "Fetch library docs",
			subNamespace: "docs",
		}]);
	});

	it("loads JSON HTTP contributions and defaults serverName to listName", () => {
		const root = packRoot("http-json");
		w(path.join(root, "mcp", "remote.json"), JSON.stringify({
			label: "Remote Docs",
			transport: {
				type: "http",
				url: "https://mcp.example.test/mcp?tenant=docs",
				headers: { Authorization: "Bearer ${DOCS_MCP_TOKEN}" },
			},
		}, null, 2));

		assert.deepEqual(loadPackContributions(root, manifest(["remote"])).mcp, [{
			listName: "remote",
			serverName: "remote",
			config: {
				url: "https://mcp.example.test/mcp?tenant=docs",
				headers: { Authorization: "Bearer ${DOCS_MCP_TOKEN}" },
			},
			sourceFile: path.join(root, "mcp", "remote.json"),
			packRoot: root,
			label: "Remote Docs",
		}]);
	});

	it("drops malformed MCP files without crashing the pack scan", () => {
		const root = packRoot("malformed-drop");
		w(path.join(root, "mcp", "good.yaml"), "transport:\n  type: stdio\n  command: node\n");
		w(path.join(root, "mcp", "bad.yaml"), "server: bad__name\ntransport:\n  type: stdio\n  command: node\n");

		const contributions = loadMcpContributions(root, manifest(["bad", "good"]));
		assert.deepEqual(contributions.map((c) => c.listName), ["good"]);
	});

	it("rejects mixed/unknown transport declarations and invalid HTTP URLs", () => {
		const root = packRoot("invalid-transport");
		const sourceFile = path.join(root, "mcp", "bad.yaml");
		assert.throws(
			() => normalizeMcpContribution({ transport: { type: "stdio", command: "node", url: "https://example.test" } }, { listName: "bad", sourceFile, packRoot: root }),
			(e) => e instanceof McpContributionValidationError && /unknown key "url"/.test(e.message),
		);
		assert.throws(
			() => normalizeMcpContribution({ transport: { type: "http", url: "ftp://example.test" } }, { listName: "bad", sourceFile, packRoot: root }),
			(e) => e instanceof McpContributionValidationError && /http: or https:/.test(e.message),
		);
		assert.throws(
			() => normalizeMcpContribution({ transport: { type: "http", url: "https://user:pass@example.test/mcp#frag" } }, { listName: "bad", sourceFile, packRoot: root }),
			McpContributionValidationError,
		);
	});

	it("rejects unknown top-level keys, string-only maps, and cwd escapes", () => {
		const root = packRoot("strict-schema");
		const sourceFile = path.join(root, "mcp", "bad.yaml");
		assert.throws(
			() => normalizeMcpContribution({ extra: true, transport: { type: "stdio", command: "node" } }, { listName: "bad", sourceFile, packRoot: root }),
			(e) => e instanceof McpContributionValidationError && /unknown key "extra"/.test(e.message),
		);
		assert.throws(
			() => normalizeMcpContribution({ transport: { type: "http", url: "https://example.test", headers: { Ok: 1 } } }, { listName: "bad", sourceFile, packRoot: root }),
			(e) => e instanceof McpContributionValidationError && /headers.Ok must be a string/.test(e.message),
		);
		assert.throws(
			() => normalizeMcpContribution({ transport: { type: "stdio", command: "node", cwd: ".." } }, { listName: "bad", sourceFile, packRoot: root }),
			(e) => e instanceof McpContributionValidationError && /outside the pack root/.test(e.message),
		);
	});

	it("throws on duplicate MCP list names within a pack", () => {
		const root = packRoot("duplicate-listname");
		w(path.join(root, "mcp", "dup.yaml"), "transport:\n  type: stdio\n  command: node\n");
		assert.throws(
			() => loadMcpContributions(root, manifest(["dup", "dup"])),
			(e) => e instanceof PackContributionError && /MCP listName "dup"/.test(e.message),
		);
	});

	it("does not load schema-1 MCP declarations", () => {
		const root = packRoot("schema-one");
		w(path.join(root, "mcp", "ignored.yaml"), "transport:\n  type: stdio\n  command: node\n");
		const schema1 = { ...manifest(["ignored"]), schema: 1 };
		assert.deepEqual(loadMcpContributions(root, schema1), []);
	});
});
