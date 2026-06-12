/**
 * Unit tests for `isExclusiveMode()` — exclusivity is DERIVED from gateway type,
 * not a manual toggle. Pins the §4 truth table:
 *
 *   | Gateways enabled                          | Mode      |
 *   |-------------------------------------------|-----------|
 *   | one `aigw`                                | exclusive |
 *   | `aigw` + `openai-compatible`              | exclusive |
 *   | only `openai-compatible`(s)               | merged    |
 *   | `aigw` disabled + `openai-compatible`     | merged    |
 *   | none enabled                              | merged    |
 *
 * (docs/design/multi-gateway-providers.md §4.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isExclusiveMode, type ModelGateway } from "../src/server/agent/aigw-manager.ts";

const aigw = (enabled: boolean): ModelGateway => ({ id: "a", name: "aigw", url: "http://gw/v1", type: "aigw", enabled });
const local = (name: string, enabled: boolean): ModelGateway => ({ id: name, name, url: "http://host:9292", type: "openai-compatible", enabled });

describe("isExclusiveMode (derived exclusivity)", () => {
	it("one enabled aigw ⇒ exclusive", () => {
		assert.equal(isExclusiveMode([aigw(true)]), true);
	});

	it("aigw + openai-compatible both enabled ⇒ exclusive", () => {
		assert.equal(isExclusiveMode([aigw(true), local("llama-swap", true)]), true);
	});

	it("only openai-compatible(s) enabled ⇒ merged", () => {
		assert.equal(isExclusiveMode([local("llama-swap", true), local("ollama", true)]), false);
	});

	it("aigw DISABLED + openai-compatible enabled ⇒ merged (disabled aigw is not exclusive)", () => {
		assert.equal(isExclusiveMode([aigw(false), local("llama-swap", true)]), false);
	});

	it("none enabled ⇒ merged", () => {
		assert.equal(isExclusiveMode([aigw(false), local("llama-swap", false)]), false);
	});

	it("empty list ⇒ merged", () => {
		assert.equal(isExclusiveMode([]), false);
	});
});
