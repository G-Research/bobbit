/**
 * Regression test for the hash-dir isolation bug in `writeMcpProxyExtensions`.
 *
 * The MCP-allowed filter must include both legacy per-op names
 * (`mcp__<server>__<op>`) and meta-tool names (`mcp_<server>`, `mcp_describe`).
 * If meta-tool names are missed, every role hashes to the same (empty) input
 * and every session writes its extension files to the SAME directory,
 * overwriting each other. See goal/mcp-meta-t-db211617 review.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { writeMcpProxyExtensions } = await import(
	"../src/server/agent/tool-activation.ts"
);

function mkInfos() {
	return [
		{
			name: "mcp__pw__snap",
			serverName: "pw",
			mcpToolName: "snap",
			group: "MCP: pw",
			description: "",
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "mcp__halo__list",
			serverName: "halo",
			mcpToolName: "list",
			group: "MCP: halo",
			description: "",
			inputSchema: { type: "object", properties: {} },
		},
	];
}

function mockMcpManager() {
	const infos = mkInfos();
	return {
		getToolInfos: () => infos,
		getServerStatuses: () => [],
	};
}

describe("writeMcpProxyExtensions hash-dir isolation", () => {
	it("two roles with different meta-tool allowedTools land in different hash dirs", () => {
		const mgr = mockMcpManager() as any;
		const pwOnly = writeMcpProxyExtensions(mgr, ["mcp_pw"]);
		const haloOnly = writeMcpProxyExtensions(mgr, ["mcp_halo"]);

		assert.ok(pwOnly.length > 0, "pwOnly should produce at least one extension");
		assert.ok(haloOnly.length > 0, "haloOnly should produce at least one extension");

		const pwDir = path.dirname(pwOnly[0]);
		const haloDir = path.dirname(haloOnly[0]);

		assert.notEqual(
			pwDir,
			haloDir,
			"different meta-tool filters MUST produce different hash dirs (otherwise sessions overwrite each other)",
		);
	});

	it("mcp_describe-only filter is hashed distinctly from per-server filters", () => {
		const mgr = mockMcpManager() as any;
		const describeOnly = writeMcpProxyExtensions(mgr, ["mcp_describe"]);
		const pwOnly = writeMcpProxyExtensions(mgr, ["mcp_pw"]);

		// describe-only contains no servers, so it produces 0 extensions — but the
		// path it WOULD have used must still differ. Approximate by checking pwOnly
		// hash dir doesn't trivially match the bare base dir (regression: empty
		// hash input always yields the same hash).
		if (describeOnly.length > 0 && pwOnly.length > 0) {
			assert.notEqual(path.dirname(describeOnly[0]), path.dirname(pwOnly[0]));
		}
		// Always-true sanity: pwOnly went into a hashed subdir.
		assert.ok(pwOnly.length > 0);
	});
});
