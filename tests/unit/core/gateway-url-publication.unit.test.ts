import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import { persistPublishedGatewayUrl, type FsLike } from "../../../src/server/server.ts";

const STATE_DIR = path.resolve("fixture-state");
const TARGET = path.join(STATE_DIR, "gateway-url");
const GATEWAY_URL = "http://127.0.0.1:43123/team/bobbit";

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe("gateway URL publication", () => {
	it("publishes with one rename when the destination can be replaced directly", () => {
		const events: Array<{ operation: string; from?: string; to?: string; content?: string }> = [];
		const fileSystem = {
			writeFileSync(file: string, content: string) {
				events.push({ operation: "write", to: file, content });
			},
			renameSync(from: string, to: string) {
				events.push({ operation: "rename", from, to });
			},
			unlinkSync(file: string) {
				events.push({ operation: "unlink", to: file });
			},
		} as unknown as FsLike;

		persistPublishedGatewayUrl(STATE_DIR, GATEWAY_URL, fileSystem, "linux");

		assert.equal(events.length, 2);
		assert.deepEqual(events[0], {
			operation: "write",
			to: events[0]!.to,
			content: GATEWAY_URL,
		});
		assert.match(events[0]!.to!, /^.*gateway-url\..*\.tmp$/u);
		assert.deepEqual(events[1], {
			operation: "rename",
			from: events[0]!.to,
			to: TARGET,
		});
	});

	it("replaces an existing Windows destination after a replace-specific rename failure", () => {
		const events: Array<{ operation: string; from?: string; to?: string }> = [];
		let renameCalls = 0;
		const fileSystem = {
			writeFileSync(file: string) {
				events.push({ operation: "write", to: file });
			},
			renameSync(from: string, to: string) {
				events.push({ operation: "rename", from, to });
				renameCalls += 1;
				if (renameCalls === 1) throw errno("EPERM");
			},
			unlinkSync(file: string) {
				events.push({ operation: "unlink", to: file });
			},
		} as unknown as FsLike;

		persistPublishedGatewayUrl(STATE_DIR, GATEWAY_URL, fileSystem, "win32");

		const temp = events[0]!.to;
		assert.deepEqual(events, [
			{ operation: "write", to: temp },
			{ operation: "rename", from: temp, to: TARGET },
			{ operation: "unlink", to: TARGET },
			{ operation: "rename", from: temp, to: TARGET },
		]);
	});

	it("preserves the destination and original error for unrelated rename failures", () => {
		const failure = errno("EXDEV");
		const unlinked: string[] = [];
		let temp = "";
		const fileSystem = {
			writeFileSync(file: string) {
				temp = file;
			},
			renameSync() {
				throw failure;
			},
			unlinkSync(file: string) {
				unlinked.push(file);
			},
		} as unknown as FsLike;

		assert.throws(
			() => persistPublishedGatewayUrl(STATE_DIR, GATEWAY_URL, fileSystem, "win32"),
			(error) => error === failure,
		);
		assert.deepEqual(unlinked, [temp], "only the sibling temporary file may be cleaned");
		assert.notEqual(temp, TARGET);
	});

	it("leaves the CLI callback as a URL provider rather than a second state-file publisher", () => {
		const source = readFileSync(new URL("../../../src/server/cli.ts", import.meta.url), "utf8");
		assert.doesNotMatch(source, /writeFileAtomic|gatewayUrlPath/u);
		assert.match(source, /onBound: \(actualPort\) => \{[\s\S]*?return startupUrls\.peerUrl;[\s\S]*?\},\n\t\tagentCliPath:/u);
	});
});
