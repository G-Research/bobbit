import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createMemFs } from "../harness/mem-fs.js";
import { loadHooks } from "../../src/server/agent/pack-contributions.ts";
import type { PackManifest } from "../../src/server/agent/pack-types.ts";

const memoryFs = createMemFs();
const root = path.resolve("/memfs/selector-metadata/market-packs/example");
const spies: Array<{ mockRestore(): void }> = [];

beforeAll(() => {
	memoryFs.mkdirSync(root, { recursive: true });
	for (const name of ["existsSync", "mkdirSync", "readFileSync", "readdirSync", "rmSync", "writeFileSync"] as const) {
		spies.push(vi.spyOn(fs, name).mockImplementation(memoryFs[name].bind(memoryFs) as never));
	}
	spies.push(vi.spyOn(fs, "realpathSync").mockImplementation(((file: fs.PathLike) => {
		const resolved = path.resolve(String(file));
		if (!memoryFs.existsSync(resolved)) throw new Error("ENOENT");
		return resolved;
	}) as typeof fs.realpathSync));
});

afterAll(() => {
	for (const spy of spies.reverse()) spy.mockRestore();
});

function manifest(): PackManifest {
	return { name: "example", version: "1.0.0", schema: 2, contents: { hooks: ["selector"] } } as PackManifest;
}

function writeHook(yaml: string): void {
	memoryFs.mkdirSync(path.join(root, "hooks"), { recursive: true });
	memoryFs.writeFileSync(path.join(root, "hooks", "selector.yaml"), yaml, "utf8");
	memoryFs.writeFileSync(path.join(root, "hooks", "selector.mjs"), "export {}", "utf8");
}

describe("hook selector metadata", () => {
	it("normalizes selectors only for sessionSetup decide hooks", () => {
		writeHook("id: choose\nmodule: ./selector.mjs\nevents: [sessionSetup]\nmode: decide\ncapabilities: []\nselectors: [skills, mcp]\n");
		expect(loadHooks(root, manifest())).toMatchObject([{ id: "choose", selectors: ["skills", "mcp"] }]);

		writeHook("id: choose\nmodule: ./selector.mjs\nevents: [sessionSetup]\nmode: observe\ncapabilities: []\nselectors: [skills]\n");
		expect(loadHooks(root, manifest())).toEqual([]);

		writeHook("id: choose\nmodule: ./selector.mjs\nevents: [afterTurn]\nmode: decide\ncapabilities: []\nselectors: [skills, skills]\n");
		expect(loadHooks(root, manifest())).toEqual([]);
	});
});
