import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensurePiAiBedrockHeadersPatch } from "../src/server/agent/pi-ai-bedrock-headers-patch.ts";

const PATCH_MARKER = "bobbit-pi-ai-bedrock-headers-patch-v1";

function packageRootFromResolved(specifier: string): string {
	const resolved = fileURLToPath(import.meta.resolve(specifier));
	let dir = path.dirname(resolved);
	while (true) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Could not find package root for ${specifier} from ${resolved}`);
}

function installedAmazonBedrockProviderFile(): string {
	const root = packageRootFromResolved("@earendil-works/pi-ai");
	return path.join(root, "dist", "providers", "amazon-bedrock.js");
}

describe("Pi AI Bedrock headers patch compatibility", () => {
	it("patches the installed amazon-bedrock.js provider or detects it already patched", () => {
		const providerFile = installedAmazonBedrockProviderFile();
		assert.ok(fs.existsSync(providerFile), `installed pi-ai Bedrock provider missing: ${providerFile}`);

		const before = fs.readFileSync(providerFile, "utf-8");
		const alreadyPatched = before.includes(PATCH_MARKER);
		if (!alreadyPatched) {
			assert.ok(
				before.includes(`import { transformMessages } from "./transform-messages.js";\n`),
				"pi-ai amazon-bedrock.js import anchor changed before Bobbit patch could apply",
			);
			assert.ok(
				before.includes("            const client = new BedrockRuntimeClient(config);\n"),
				"pi-ai amazon-bedrock.js client-construction anchor changed before Bobbit patch could apply",
			);
		}

		ensurePiAiBedrockHeadersPatch();

		const after = fs.readFileSync(providerFile, "utf-8");
		assert.ok(
			after.includes(PATCH_MARKER),
			"Bobbit Bedrock headers patch marker was not present after ensurePiAiBedrockHeadersPatch()",
		);
		assert.ok(
			after.includes("applyBobbitBedrockRequestHeaders(client, model, options);"),
			"Bobbit Bedrock request-header hook was not inserted into pi-ai amazon-bedrock.js",
		);
	});
});
