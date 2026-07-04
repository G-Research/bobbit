import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLikelyGeneratedPath } from "../src/shared/pr-walkthrough/generated-path.ts";

describe("isLikelyGeneratedPath", () => {
	it("classifies built marketplace pack outputs as generated", () => {
		assert.equal(isLikelyGeneratedPath("market-packs/terminal/lib/terminal-panel.js"), true);
		assert.equal(isLikelyGeneratedPath("market-packs/example/lib/nested/chunk.mjs"), true);
		assert.equal(isLikelyGeneratedPath("market-packs/terminal/src/terminal-panel.ts"), false);
	});

	it("classifies broad minified filenames and lockfiles as generated", () => {
		for (const filePath of [
			"assets/app.min.js",
			"assets/app.min.mjs",
			"assets/app.min.cjs",
			"assets/app.min.css.map",
			"package-lock.json",
			"npm-shrinkwrap.json",
			"pnpm-lock.yaml",
			"yarn.lock",
			"bun.lock",
			"bun.lockb",
			"Cargo.lock",
			"Gemfile.lock",
			"poetry.lock",
			"go.sum",
		]) {
			assert.equal(isLikelyGeneratedPath(filePath), true, filePath);
		}
	});

	it("classifies dist, build, generated, and common output paths", () => {
		for (const filePath of [
			"dist/bundle.js",
			"packages/app/build/client.js",
			"generated/schema.ts",
			"src/__generated__/types.ts",
			"coverage/lcov.info",
			".next/server/app.js",
			"schema.generated.ts",
			"service.pb.go",
			"foo_pb2.py",
			"component.g.cs",
			"model.designer.cs",
			"bundle.js.map",
		]) {
			assert.equal(isLikelyGeneratedPath(filePath), true, filePath);
		}
	});

	it("does not classify ordinary source paths as generated", () => {
		for (const filePath of [
			"src/lib/terminal-panel.ts",
			"src/components/build-panel.ts",
			"src/lockfile-editor.ts",
			"src/g.ts",
			"market-packs/terminal/src/terminal-panel.ts",
		]) {
			assert.equal(isLikelyGeneratedPath(filePath), false, filePath);
		}
	});
});
