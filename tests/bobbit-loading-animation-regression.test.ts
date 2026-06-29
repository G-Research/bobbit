import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const renderSource = readFileSync(new URL("../src/app/render.ts", import.meta.url), "utf8");
const chatPanelSource = readFileSync(new URL("../src/ui/ChatPanel.ts", import.meta.url), "utf8");

test("main content loader uses the Bobbit mascot animation, not a generic spinner", () => {
	assert.match(
		renderSource,
		/import \{ bobbitLoadingAnimation \} from "\.\.\/ui\/components\/BobbitLoadingAnimation\.js";/,
		"src/app/render.ts should use the shared Bobbit loading animation",
	);
	assert.doesNotMatch(
		renderSource,
		/function bobbitLoadingAnimation\s*\(/,
		"src/app/render.ts must not shadow the shared Bobbit loader with a local fallback",
	);
});

test("new-session ChatPanel connecting state uses the Bobbit mascot animation", () => {
	assert.match(
		chatPanelSource,
		/import \{ bobbitLoadingAnimation \} from "\.\/components\/BobbitLoadingAnimation\.js";/,
		"ChatPanel should use the shared Bobbit loading animation while connecting",
	);
	assert.doesNotMatch(
		chatPanelSource,
		/border-t-transparent rounded-full/,
		"ChatPanel connecting state must not regress to the generic CSS spinner",
	);
});
