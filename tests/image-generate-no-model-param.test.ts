/**
 * Pinning test for the "lock image model to selector" goal.
 *
 * The `generate_image` tool MUST NOT advertise a `model` parameter — the image
 * model is controlled solely by the session image-model selector / settings
 * default. We import `defaults/tools/images/extension.ts` with a fake `pi` that
 * captures the registered tool and assert `parameters.properties.model` is gone
 * while `prompt` is still present. Never reintroduce a tool-driven model arg.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

let captured: any;

before(async () => {
	const file = path.join(REPO_ROOT, "defaults/tools/images/extension.ts");
	const mod: any = await import(pathToFileURL(file).href);
	const factory = typeof mod.default === "function" ? mod.default : mod.default?.default;
	assert.ok(typeof factory === "function", "images/extension.ts has no callable default export");
	const pi = {
		registerTool(def: any) {
			if (def?.name === "generate_image") captured = def;
		},
		on() {},
	};
	factory(pi);
	assert.ok(captured, "generate_image tool was not registered");
});

describe("generate_image schema", () => {
	it("does NOT advertise a `model` parameter", () => {
		const props = captured.parameters?.properties ?? {};
		assert.equal(props.model, undefined, "generate_image must not expose a `model` param");
	});

	it("still advertises `prompt`", () => {
		const props = captured.parameters?.properties ?? {};
		assert.ok(props.prompt, "generate_image must still expose `prompt`");
	});

	it("does not mention overriding `model` in prompt guidance", () => {
		const snippet = String(captured.promptSnippet ?? "");
		const guidelines = (captured.promptGuidelines ?? []).join("\n");
		assert.ok(!/model\s*=/.test(snippet), "promptSnippet must not instruct passing model=");
		assert.ok(!/model\s*=/.test(guidelines), "promptGuidelines must not instruct passing model=");
	});
});
