import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
import { enableTsWorkerResolver } from "../../../tests/support/helpers/unit/enable-ts-worker.js";
import { loadPackContributions } from "../../../src/server/agent/pack-contributions.js";
import { parseManifest } from "../../../src/server/agent/pack-manifest.js";
import { PackLocalDataResolver } from "../../../src/server/extension-host/pack-local-data.js";
import { createServerHostApi } from "../../../src/server/extension-host/server-host-api.js";
import { ModuleHost } from "../../../src/server/extension-host/module-host-worker.js";
import activateMarker from "../../../market-packs/_fixtures/pack-local-data/pi-extensions/marker/extension.js";

guardProcessEnv();
enableTsWorkerResolver();

const PACK_ID = "pack-local-data";
const PACK_ROOT = fileURLToPath(new URL("../../../market-packs/_fixtures/pack-local-data", import.meta.url));
const ROUTES = path.join(PACK_ROOT, "lib", "routes.mjs");
const tempRoots: string[] = [];
const originalBinding = process.env.BOBBIT_PACK_LOCAL_DATA_JSON;

afterEach(() => {
	if (originalBinding === undefined) delete process.env.BOBBIT_PACK_LOCAL_DATA_JSON;
	else process.env.BOBBIT_PACK_LOCAL_DATA_JSON = originalBinding;
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("pack local-data fixture realm parity", () => {
	it("shares one canonical directory across resolver, confined server route, Pi tool, and ordinary filesystem access", async () => {
		const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pack-local-data-integration-")));
		tempRoots.push(projectRoot);
		const componentCwd = path.join(projectRoot, "components", "web");
		fs.mkdirSync(componentCwd, { recursive: true });

		const problems: string[] = [];
		const manifest = parseManifest(fs.readFileSync(path.join(PACK_ROOT, "pack.yaml"), "utf8"), problems);
		expect(problems).toEqual([]);
		expect(manifest?.localData?.directory).toBe(".pack-local-data-fixture");
		const contribution = loadPackContributions(PACK_ROOT, manifest!);
		let active = true;
		const resolver = new PackLocalDataResolver(
			{ get: id => id === "project-fixture" ? ({ id, rootPath: projectRoot } as never) : undefined },
			{
				getPack: (_projectId, packId) => active && packId === PACK_ID ? contribution : undefined,
				list: () => active ? [contribution] : [],
			},
		);
		const directory = resolver.resolveHostDirectory("project-fixture", PACK_ID);
		expect(directory).toBe(path.join(projectRoot, ".pack-local-data-fixture"));
		expect(directory.startsWith(componentCwd)).toBe(false);

		const host = createServerHostApi({
			sessionId: "session-fixture",
			packId: PACK_ID,
			contributionId: "pack-local-data/snapshot",
			localDataDirectory: directory,
			capabilityMask: { localData: true },
		});
		const moduleHost = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const written = await moduleHost.invoke({
				url: pathToFileURL(ROUTES).href,
				packRoot: PACK_ROOT,
				epoch: 0,
				exportKind: "routes",
				member: "write",
				ctx: { host, sessionId: "session-fixture", toolUseId: "", tool: "route:write", workingDir: componentCwd },
				arg: { body: { name: "host-marker.txt", content: "written-through-route" } },
			});
			expect(written).toEqual({ directory, name: "host-marker.txt", content: "written-through-route" });

			fs.writeFileSync(path.join(directory, "ordinary-marker.txt"), "written-directly", "utf8");
			process.env.BOBBIT_PACK_LOCAL_DATA_JSON = JSON.stringify({ [PACK_ID]: directory });
			let markerHandler: ((input: any) => Promise<any>) | undefined;
			activateMarker({ tool: (_definition: unknown, handler: (input: any) => Promise<any>) => { markerHandler = handler; } });
			const piResult = await markerHandler!({ operation: "write", name: "pi-marker.txt", content: "written-through-pi" });
			expect(piResult).toEqual({ directory, name: "pi-marker.txt", content: "written-through-pi" });

			const snapshot = await moduleHost.invoke({
				url: pathToFileURL(ROUTES).href,
				packRoot: PACK_ROOT,
				epoch: 0,
				exportKind: "routes",
				member: "snapshot",
				ctx: { host, sessionId: "session-fixture", toolUseId: "", tool: "route:snapshot", workingDir: componentCwd },
				arg: {},
			});
			expect(snapshot).toMatchObject({
				directory,
				markers: {
					"host-marker.txt": "written-through-route",
					"ordinary-marker.txt": "written-directly",
					"pi-marker.txt": "written-through-pi",
				},
			});

			active = false;
			expect(() => resolver.resolveHostDirectory("project-fixture", PACK_ID)).toThrow(/not active/);
			expect(fs.readFileSync(path.join(directory, "host-marker.txt"), "utf8")).toBe("written-through-route");
			expect(fs.readFileSync(path.join(directory, "pi-marker.txt"), "utf8")).toBe("written-through-pi");
		} finally {
			moduleHost.dispose();
		}
	});
});
