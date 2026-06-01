/**
 * S31 — the WS frame cap is explicit and coherent with the composer limit.
 *
 * The gateway must set maxPayload explicitly (not inherit ws's silent 100 MiB)
 * and it must exceed the composer's aggregate-send limit so an oversized send is
 * rejected with a clear error (handleSend) BEFORE it could trip a close-1009
 * socket teardown. Source-scan (no server boot). See 02-analysis.md S31.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function num(src: string, re: RegExp, label: string): number {
	const m = src.match(re);
	assert.ok(m, `could not find ${label}`);
	// eslint-disable-next-line no-eval
	return Function(`"use strict";return (${m![1]})`)() as number;
}

test("WebSocketServer sets an explicit maxPayload above the composer aggregate limit", () => {
	const server = fs.readFileSync(path.resolve("src/server/server.ts"), "utf-8");
	const editor = fs.readFileSync(path.resolve("src/ui/components/MessageEditor.ts"), "utf-8");

	const socketCap = num(server, /WS_MAX_PAYLOAD_BYTES\s*=\s*([0-9*\s]+);/, "WS_MAX_PAYLOAD_BYTES");
	const composerCap = num(editor, /MAX_SERIALIZED_SEND_BYTES\s*=\s*([0-9*\s]+);/, "MAX_SERIALIZED_SEND_BYTES");

	// Explicitly configured on the server (not the ws 100 MiB default).
	assert.match(server, /maxPayload:\s*WS_MAX_PAYLOAD_BYTES/, "wss must pass maxPayload: WS_MAX_PAYLOAD_BYTES");
	assert.equal(socketCap, 256 * 1024 * 1024, "socket cap should be 256 MiB");
	assert.equal(composerCap, 200 * 1024 * 1024, "composer cap should be 200 MiB");
	assert.ok(socketCap > composerCap, "socket cap must exceed the composer limit so rejection beats teardown");
});
