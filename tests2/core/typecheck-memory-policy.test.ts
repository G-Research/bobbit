import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	scripts?: Record<string, string>;
};

const EXPECTED_CHECK = "shx mkdir -p .profiles && node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit --incremental --tsBuildInfoFile .profiles/check-server.tsbuildinfo && node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit --incremental --tsBuildInfoFile .profiles/check-web.tsbuildinfo && node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -p tsconfig.tests2.json --noEmit --incremental --tsBuildInfoFile .profiles/check-tests2.tsbuildinfo";

describe("TypeScript check memory policy", () => {
	it("gives every sequential compiler a bounded 4 GiB heap without replacing NODE_OPTIONS", () => {
		assert.equal(packageJson.scripts?.check, EXPECTED_CHECK);
		assert.doesNotMatch(packageJson.scripts?.check ?? "", /NODE_OPTIONS/);
	});
});
