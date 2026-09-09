import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
	buildRequestAdmissionCliConfig,
	hasVersionFlag,
	nordViteOrigins,
	normalizeConfiguredOrigin,
	parseArgs,
} from "../../../src/server/cli.ts";
import { DEFAULT_VITE_PORT } from "../../../vite.config.ts";

describe("request-admission CLI configuration", () => {
	it("reads and canonicalizes the comma-separated public-origin environment list", () => {
		const args = parseArgs([], {
			BOBBIT_PUBLIC_ORIGINS: "https://Proxy.Example.:443, http://127.0.0.1:3001",
		});

		assert.deepEqual(args.publicOrigins, [
			"https://proxy.example",
			"http://127.0.0.1:3001",
		]);
	});

	it("uses repeatable public-origin flags in preference to the environment", () => {
		const args = parseArgs([
			"--public-origin", "https://Gateway.Example./",
			"--public-origin", "http://[0:0:0:0:0:0:0:1]:8080",
		], { BOBBIT_PUBLIC_ORIGINS: "not an origin" });

		assert.deepEqual(args.publicOrigins, ["https://gateway.example", "http://[::1]:8080"]);
	});

	it("deduplicates normalized explicit Vite origins without accepting arbitrary ports", () => {
		assert.deepEqual(
			parseArgs([], { BOBBIT_VITE_ORIGINS: "https://Mesh.Example.:5173/" }).viteOrigins,
			["https://mesh.example:5173"],
		);
		const args = parseArgs([
			"--vite-origin", "http://LOCALHOST:5173/",
			"--vite-origin", "http://localhost:5173",
		], { BOBBIT_VITE_ORIGINS: "not an origin" });

		assert.deepEqual(args.viteOrigins, ["http://localhost:5173"]);
		assert.equal(DEFAULT_VITE_PORT, 5173);
	});

	it.each([
		"ftp://gateway.example",
		"https://user@gateway.example",
		"https://gateway.example/a",
		"https://gateway.example/a/..",
		"https://gateway.example?",
		"https://gateway.example#fragment",
		"https://gateway.example:99999",
		"null",
	])("rejects malformed or non-origin configuration %j", (origin) => {
		assert.throws(() => normalizeConfiguredOrigin(origin), /invalid/i);
	});

	it("rejects ambiguous environment lists and missing repeatable option values", () => {
		assert.throws(
			() => parseArgs([], { BOBBIT_PUBLIC_ORIGINS: "https://one.example,,https://two.example" }),
			/public origin list/i,
		);
		assert.throws(() => parseArgs(["--public-origin"], {}), /public-origin.*requires a value/i);
		assert.throws(() => parseArgs(["--vite-origin", "--no-ui"], {}), /vite-origin.*requires a value/i);
	});

	it("does not interpret a configured origin value as the version flag", () => {
		assert.equal(hasVersionFlag(["--public-origin", "--version"]), false);
		assert.equal(hasVersionFlag(["--vite-origin", "--version"]), false);
	});

	it("passes only finite normalized certificate names and excludes wildcard listeners", () => {
		assert.deepEqual(buildRequestAdmissionCliConfig({
			bindHost: "0:0:0:0:0:0:0:0",
			tlsHostnames: ["Public.Example.", "2001:0db8:0:0:0:0:0:8", "0.0.0.0"],
			publicOrigins: ["https://Public.Example.:8443/"],
			viteOrigins: ["http://localhost:5173"],
		}), {
			publicOrigins: ["https://public.example:8443"],
			viteOrigins: ["http://localhost:5173"],
			tlsHostnames: ["127.0.0.1", "localhost", "public.example", "2001:db8::8"],
		});
	});

	it("derives the Nord development exception only from configured finite hosts", () => {
		assert.deepEqual(nordViteOrigins({
			bindHost: "100.64.0.12",
			publicHostnames: ["Bobbit.Example."],
		}), ["https://100.64.0.12:5173", "https://bobbit.example:5173"]);
		assert.throws(
			() => nordViteOrigins({ bindHost: "0.0.0.0" }),
			/invalid Vite hostname/i,
		);
	});

	it("pins local dev scripts to the finite configured Vite origin", () => {
		const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		for (const name of ["dev", "dev:harness", "dev:watchdog"]) {
			assert.match(pkg.scripts[name]!, /--vite-origin http:\/\/localhost:5173/);
			assert.match(pkg.scripts[name]!, /dev-vite\.mjs --port 5173 --strictPort/);
		}
	});
});
