import assert from "node:assert/strict";

import { afterEach, describe, it } from "vitest";

import {
	bytes,
	cleanupRealPiRoots,
	createLifecycleSession,
	loadRealPiLifecycleBoundaryFixture,
	persistOutcome,
	READ_SESSION_FINAL_RESULT_MAX_BYTES,
	runLifecycle,
	toolOutcome,
} from "./tool-result-error-bridge-real-pi-fixture.js";

afterEach(cleanupRealPiRoots);

describe("hostile snapshots through Pi's real extension runner", () => {
	it("bounds hostile structures while preserving the safe pre-listener snapshot", async () => {
		const { root, loaded, frozenTargetCounters } = await loadRealPiLifecycleBoundaryFixture();
		for (const snapshotAttack of ["deep", "error_deep", "sparse", "cycle", "dag", "nonplain"] as const) {
			const hostileSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				snapshot_attack: snapshotAttack,
			});
			const hostileEvents = await runLifecycle(hostileSession, `snapshot ${snapshotAttack}`);
			const { emitted: hostileEnd } = toolOutcome(hostileEvents);
			const hostileStored = persistOutcome(hostileSession);
			assert.ok(bytes(hostileEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(Buffer.byteLength(hostileStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			const fallback = JSON.parse(hostileStored.roundTrip.content[0].text);
			if (snapshotAttack === "error_deep") {
				assert.equal(hostileStored.roundTrip.isError, true);
				assert.equal(fallback.error, "read_session_failed");
			} else {
				assert.equal(fallback.truncatedBy, "extension_return_unrecognized");
			}
			assert.equal(hostileStored.line.includes("ACCESSOR_PROVIDER_DATA"), false);
		}

		for (const frozenTargetAttack of ["getter", "toJSON"] as const) {
			const frozenSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				frozen_target_attack: frozenTargetAttack,
			});
			const frozenEvents = await runLifecycle(frozenSession, `frozen target ${frozenTargetAttack}`);
			const { emitted: frozenEnd, persisted: frozenMessage } = toolOutcome(frozenEvents);
			const frozenStored = persistOutcome(frozenSession);
			assert.ok(bytes(frozenEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(frozenMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(Buffer.byteLength(frozenStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(JSON.parse(frozenStored.roundTrip.content[0].text).messages[0].index, 7,
				"the safe pre-listener snapshot must remain authoritative");
		}
		assert.deepEqual(frozenTargetCounters, { getter: 0, toJSON: 0 },
			"frozen listener-controlled accessors and serializers must never execute");

	});
});
