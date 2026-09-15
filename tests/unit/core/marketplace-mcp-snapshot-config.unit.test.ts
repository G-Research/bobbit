import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	MarketplaceMcpSnapshotConfigError,
	snapshotBackedMcpConfig,
} from "../../../src/server/mcp/marketplace-mcp-snapshot-config.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-mcp-snapshot-config-"));
	roots.push(root);
	return root;
}

describe("Marketplace MCP snapshot runtime config", () => {
	it("rebases normalized pack-local command, argument, environment, and cwd paths", () => {
		const root = temporaryRoot();
		const live = path.join(root, "market-packs", "trusted-pack");
		const snapshot = path.join(root, "private", "snapshot");
		const aliased = `${path.join(root, "market-packs")}${path.sep}.${path.sep}trusted-pack${path.sep}server.mjs`;
		const config = snapshotBackedMcpConfig({
			command: aliased,
			args: [`--loader=${aliased}`, "relative-resource.mjs", "/external/tool"],
			env: { SCRIPT: aliased, SEARCH: `${aliased}${path.delimiter}/external/bin` },
			cwd: path.join(live, "work"),
		}, live, snapshot);

		expect(config).toEqual({
			command: path.join(snapshot, "server.mjs"),
			args: [`--loader=${path.join(snapshot, "server.mjs")}`, "relative-resource.mjs", "/external/tool"],
			env: {
				SCRIPT: path.join(snapshot, "server.mjs"),
				SEARCH: `${path.join(snapshot, "server.mjs")}${path.delimiter}/external/bin`,
			},
			cwd: path.join(snapshot, "work"),
		});
	});

	it("rebases present filesystem aliases into the snapshot", () => {
		const root = temporaryRoot();
		const live = path.join(root, "trusted-pack");
		const snapshot = path.join(root, "private-snapshot");
		fs.mkdirSync(live, { recursive: true });
		fs.writeFileSync(path.join(live, "server.mjs"), "export {};\n");
		const alias = path.join(root, "pack-alias");
		try {
			fs.symlinkSync(live, alias, process.platform === "win32" ? "junction" : "dir");
		} catch {
			return;
		}

		expect(snapshotBackedMcpConfig({
			command: path.join(alias, "server.mjs"),
			args: [path.join(alias, "created-after-check", "late.mjs")],
			cwd: path.join(alias, "work"),
		}, live, snapshot)).toMatchObject({
			command: path.join(snapshot, "server.mjs"),
			args: [path.join(snapshot, "created-after-check", "late.mjs")],
			cwd: path.join(snapshot, "work"),
		});
	});

	it("handles Windows case, separators, dot segments, and boundary prefixes deterministically", () => {
		const live = "C:\\repo\\.bobbit\\config\\market-packs\\Trusted";
		const snapshot = "D:\\private\\snapshot";
		const config = snapshotBackedMcpConfig({
			command: "c:/REPO/.bobbit/config/market-packs/./trusted/bin/server.exe",
			args: ["C:\\repo\\.bobbit\\config\\market-packs\\Trusted-other\\server.exe"],
			env: { PATHS: "C:\\repo\\.bobbit\\config\\market-packs\\Trusted\\bin;C:\\external\\bin" },
			cwd: "c:/REPO/.bobbit/config/market-packs/trusted/work",
		}, live, snapshot);

		expect(config.command).toBe("D:\\private\\snapshot\\bin\\server.exe");
		expect(config.args).toEqual(["C:\\repo\\.bobbit\\config\\market-packs\\Trusted-other\\server.exe"]);
		expect(config.env?.PATHS).toBe("D:\\private\\snapshot\\bin;C:\\external\\bin");
		expect(config.cwd).toBe("D:\\private\\snapshot\\work");
	});

	it("preserves truly external cwd paths", () => {
		expect(snapshotBackedMcpConfig({
			command: "node",
			cwd: "/external/work",
		}, "/repo/packs/trusted", "/private/snapshot").cwd).toBe("/external/work");
		expect(snapshotBackedMcpConfig({
			command: "node.exe",
			cwd: "E:\\external\\work",
		}, "C:\\repo\\packs\\trusted", "D:\\private\\snapshot").cwd).toBe("E:\\external\\work");
	});

	it("fails closed for cwd traversal after entering the live pack", () => {
		expect(() => snapshotBackedMcpConfig({
			command: "node",
			cwd: "/repo/packs/./trusted/../mutable",
		}, "/repo/packs/trusted", "/private/snapshot")).toThrow(MarketplaceMcpSnapshotConfigError);
	});

	it("fails closed for cwd traversal through a live-pack alias", () => {
		const root = temporaryRoot();
		const live = path.join(root, "trusted-pack");
		const snapshot = path.join(root, "private-snapshot");
		const external = path.join(root, "mutable");
		fs.mkdirSync(live, { recursive: true });
		fs.mkdirSync(external, { recursive: true });
		const alias = path.join(root, "pack-alias");
		try {
			fs.symlinkSync(live, alias, process.platform === "win32" ? "junction" : "dir");
		} catch {
			return;
		}

		expect(() => snapshotBackedMcpConfig({
			command: "node",
			cwd: `${alias}${path.sep}..${path.sep}${path.basename(external)}`,
		}, live, snapshot)).toThrow(MarketplaceMcpSnapshotConfigError);
	});

	it("fails closed for cwd values that bypass contribution normalization", () => {
		for (const cwd of ["work", "C:\\external\\work", "\\\\server\\share\\work"]) {
			expect(() => snapshotBackedMcpConfig({ command: "node", cwd }, "/repo/packs/trusted", "/private/snapshot"))
				.toThrow(MarketplaceMcpSnapshotConfigError);
		}
		for (const cwd of ["work", "/external/work"]) {
			expect(() => snapshotBackedMcpConfig({ command: "node.exe", cwd }, "C:\\repo\\packs\\trusted", "D:\\private\\snapshot"))
				.toThrow(MarketplaceMcpSnapshotConfigError);
		}
	});

	it("fails closed when a live-pack-prefixed command path escapes through dot segments", () => {
		expect(() => snapshotBackedMcpConfig({
			command: "/repo/packs/./trusted/../mutable/server.mjs",
		}, "/repo/packs/trusted", "/private/snapshot")).toThrow(MarketplaceMcpSnapshotConfigError);
	});
});
