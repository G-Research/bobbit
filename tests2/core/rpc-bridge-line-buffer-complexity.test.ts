import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { RpcBridge } from "../../src/server/agent/rpc-bridge.ts";

const CHUNK_SIZE = 64 * 1024;

/**
 * Count newline-search receiver lengths instead of wall-clock time. This makes
 * the complexity assertion deterministic: rescanning an accumulated buffer is
 * quadratic, while scanning each incoming chunk is linear.
 */
function measuredSearchCharacters(totalLength: number): number {
	const originalIndexOf = String.prototype.indexOf;
	const originalLastIndexOf = String.prototype.lastIndexOf;
	const originalSplit = String.prototype.split;
	let searched = 0;

	(String.prototype as any).indexOf = function(search: string, position?: number): number {
		if (search === "\n") searched += String(this).length;
		return originalIndexOf.call(String(this), search, position);
	};
	(String.prototype as any).lastIndexOf = function(search: string, position?: number): number {
		if (search === "\n") searched += String(this).length;
		return originalLastIndexOf.call(String(this), search, position);
	};
	(String.prototype as any).split = function(separator?: string | RegExp, limit?: number): string[] {
		if (separator === "\n") searched += String(this).length;
		return Reflect.apply(originalSplit, String(this), [separator, limit]) as string[];
	};

	try {
		const bridge: any = new RpcBridge({});
		// A non-JSON frame exercises framing and avoids payload processing costs.
		const line = "x".repeat(totalLength - 1) + "\n";
		for (let offset = 0; offset < line.length; offset += CHUNK_SIZE) {
			bridge.handleData(line.slice(offset, offset + CHUNK_SIZE));
		}
		assert.equal(bridge.lineBuffer, "");
		return searched;
	} finally {
		String.prototype.indexOf = originalIndexOf;
		String.prototype.lastIndexOf = originalLastIndexOf;
		String.prototype.split = originalSplit;
	}
}

describe("RpcBridge incremental scanner complexity", () => {
	it("searches a large newline-free JSONL frame only linearly", () => {
		const oneMiB = 1024 * 1024;
		const fourMiB = 4 * oneMiB;
		const smallSearch = measuredSearchCharacters(oneMiB);
		const largeSearch = measuredSearchCharacters(fourMiB);

		// The final newline-bearing chunk may incur two extra receiver-length
		// counts for trailing-fragment state and loop termination, but accumulated
		// prior chunks must not be searched again.
		assert.ok(
			largeSearch <= fourMiB + CHUNK_SIZE * 2,
			`expected O(N) newline scanning, searched ${largeSearch} characters for ${fourMiB} input characters`,
		);
		assert.ok(
			largeSearch / smallSearch < 4.2,
			`expected near-linear 4x growth, got ${(largeSearch / smallSearch).toFixed(2)}x`,
		);
	});
});
