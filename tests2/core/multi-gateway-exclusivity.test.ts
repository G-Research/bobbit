// v2-native — derived gateway exclusivity must remain type-driven.
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isExclusiveMode, type ModelGateway } from "../../src/server/agent/aigw-manager.js";

const aigw = (enabled = true): ModelGateway => ({ id: "aigw-id", name: "aigw", url: "http://gateway/v1", type: "aigw", enabled });
const local = (enabled = true): ModelGateway => ({ id: "local-id", name: "local", url: "http://local:8080", type: "openai-compatible", enabled });

describe("multi-gateway derived exclusivity", () => {
	it("is enabled only by an enabled AIGW gateway", () => {
		assert.equal(isExclusiveMode([aigw()]), true);
		assert.equal(isExclusiveMode([aigw(), local()]), true);
		assert.equal(isExclusiveMode([local()]), false);
		assert.equal(isExclusiveMode([aigw(false), local()]), false);
		assert.equal(isExclusiveMode([]), false);
	});
});
