import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/app/session-manager.ts", "utf8");

describe("session-manager git-status dropdown listener wiring", () => {
	it("replaces the previous dropdown-open handler instead of stacking anonymous listeners", () => {
		const eventName = "git-status-dropdown-open";
		const firstEventIndex = source.indexOf(eventName);
		assert.notStrictEqual(firstEventIndex, -1, "session-manager wires git-status-dropdown-open");

		const wiringBlock = source.slice(Math.max(0, firstEventIndex - 500), firstEventIndex + 1200);
		assert.match(
			wiringBlock,
			/__gitStatusDropdownOpenHandler/,
			"handler must be stored on the agent interface so it can be removed on reconnect",
		);
		assert.match(
			wiringBlock,
			/removeEventListener\("git-status-dropdown-open",\s*gitStatusAgentInterface\.__gitStatusDropdownOpenHandler\)/,
			"previous handler must be removed before adding a new one",
		);
		assert.match(
			wiringBlock,
			/addEventListener\("git-status-dropdown-open",\s*gitStatusAgentInterface\.__gitStatusDropdownOpenHandler\)/,
			"addEventListener must use the stored handler rather than an anonymous closure",
		);
		assert.doesNotMatch(
			wiringBlock,
			/addEventListener\("git-status-dropdown-open",\s*\(\)\s*=>/,
			"anonymous dropdown-open listeners would stack on each connectToSession call",
		);
	});
});
