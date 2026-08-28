import { EventEmitter } from "node:events";
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PACKS,
	buildSelectedPack,
	createSerializedRebuilder,
	mirrorDeclaredOutputs,
	notifyVite,
	parseArgs,
	resolvePackBuild,
	runWatcher,
	servingTargets,
} from "../../scripts/build-market-packs.mjs";

const roots: string[] = [];
const NATIVE_TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-glibc-arm64",
	"linux-glibc-x64",
	"linux-musl-arm64",
	"linux-musl-x64",
	"win32-arm64",
	"win32-x64",
] as const;

async function fixtureRoot() {
	const root = await mkdtemp(path.join(tmpdir(), "bobbit-pack-dev-"));
	roots.push(root);
	return root;
}

function declaration(pack = "fixture") {
	return {
		pack,
		authorRoot: `market-packs/${pack}`,
		defaultServingRoot: `dist/server/builtin-packs/market-packs/${pack}`,
		entries: [
			{ in: "panel.ts", out: "lib/nested/panel.js" },
			{ in: "route.ts", out: "lib/route.mjs", platform: "node" },
		],
	};
}

async function createPackRoot(root: string, relative: string, name = "fixture") {
	const target = path.join(root, relative);
	await mkdir(target, { recursive: true });
	await writeFile(path.join(target, "pack.yaml"), `schema: 2\nname: ${name}\n`);
	return target;
}

async function createBuiltOutputs(root: string, declared = declaration()) {
	const author = await createPackRoot(root, declared.authorRoot, declared.pack);
	await mkdir(path.join(author, "lib", "nested"), { recursive: true });
	await writeFile(path.join(author, "lib", "nested", "panel.js"), "panel-current");
	await writeFile(path.join(author, "lib", "route.mjs"), "route-current");
	return author;
}

async function createNativeBuildFixture(root: string, declared = declaration()) {
	const author = await createPackRoot(root, declared.authorRoot, declared.pack);
	const packageRoot = path.join(root, "node_modules", "fixture-native");
	await mkdir(packageRoot, { recursive: true });
	await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "fixture-native": "1.0.0" } }));
	await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-native", version: "1.0.0" }));
	const targets: Record<string, string> = {};
	for (const target of NATIVE_TARGETS) {
		const relative = `prebuilds/${target}.node`;
		targets[target] = relative;
		await mkdir(path.dirname(path.join(packageRoot, relative)), { recursive: true });
		await writeFile(path.join(packageRoot, relative), `native:${target}`);
	}
	await writeFile(path.join(author, "pack.build.json"), JSON.stringify({
		schema: 1,
		nativeAssets: [{ id: "database-driver", package: "fixture-native", targets }],
	}));
	return { author, packageRoot };
}

async function createDirectoryLink(target: string, linkPath: string) {
	await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("market pack development CLI", () => {
	it("strictly parses a watched pack, repeated targets, and an HTTP(S) Vite URL", () => {
		expect(parseArgs([
			"--watch",
			"file-explorer",
			"--target",
			"dist/one/file-explorer",
			"--target",
			"dist/two/file-explorer",
			"--vite-url",
			"https://localhost:4173/base",
		])).toEqual({
			watch: true,
			pack: "file-explorer",
			targets: ["dist/one/file-explorer", "dist/two/file-explorer"],
			viteUrl: "https://localhost:4173/base",
			help: false,
		});
		expect(parseArgs([])).toMatchObject({ watch: false, pack: undefined, targets: [] });
	});

	it.each([
		[[], "Missing pack id", ["--watch"]],
		[[], "Unknown option", ["--watch", "file-explorer", "--wat"]],
		[[], "Missing value", ["--watch", "file-explorer", "--target"]],
		[[], "Unexpected extra", ["--watch", "file-explorer", "terminal"]],
		[[], "safe structural id", ["--watch", "../file-explorer"]],
		[[], "HTTP(S)", ["--watch", "file-explorer", "--vite-url", "file:///tmp/vite"]],
		[[], "unsafe path segment", ["--watch", "file-explorer", "--target", "dist/../escape"]],
	])("rejects malformed arguments %#", (_unused, message, argv) => {
		expect(() => parseArgs(argv)).toThrow(message);
	});

	it("resolves only exact declarations and reports a stable sorted allowlist", () => {
		expect(resolvePackBuild("file-explorer")).toMatchObject({
			pack: "file-explorer",
			authorRoot: "market-packs/file-explorer",
			defaultServingRoot: "dist/server/builtin-packs/market-packs/file-explorer",
		});
		expect(() => resolvePackBuild("FILE-EXPLORER")).toThrow("Invalid pack id");
		const declaredPacks = PACKS as Array<{ pack: string }>;
		const expected = declaredPacks.map(({ pack }) => pack).sort().join(", ");
		expect(() => resolvePackBuild("stale-committed-output")).toThrow(`Declared packs: ${expected}`);
		expect(declaredPacks.some(({ pack }) => pack.includes("performance"))).toBe(false);
	});
});

describe("market pack serving target resolution", () => {
	it("uses only the declared default root despite unrelated pack directories", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		await createPackRoot(root, declared.authorRoot);
		const expected = await createPackRoot(root, declared.defaultServingRoot);
		await createPackRoot(root, "dist/other-discovery/fixture");
		await createPackRoot(root, "market-packs/stale/lib/fixture");

		const targets = await servingTargets(declared, [], { projectRoot: root });
		expect(targets.map((target: { path: string }) => target.path)).toEqual([await realpath(expected)]);
		expect(targets[0]?.identity).toMatch(/^.+:.+$/);
	});

	it("fails deterministically when the default is missing or has the wrong manifest", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		await createPackRoot(root, declared.authorRoot);
		await expect(servingTargets(declared, [], { projectRoot: root })).rejects.toThrow(
			"run npm run build:server or pass --target",
		);
		await createPackRoot(root, declared.defaultServingRoot, "other");
		await expect(servingTargets(declared, [], { projectRoot: root })).rejects.toThrow(
			'manifest name must be "fixture"',
		);
	});

	it("rejects explicit manifest mismatches and source-root aliases before creating output directories", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		await createPackRoot(root, declared.authorRoot);
		await createPackRoot(root, "served/wrong", "other");
		await expect(servingTargets(declared, ["served/wrong"], { projectRoot: root })).rejects.toThrow(
			'manifest name must be "fixture"',
		);
		await expect(servingTargets(declared, [declared.authorRoot], { projectRoot: root })).rejects.toThrow(
			"aliases the authored pack root",
		);
	});

	it("canonicalizes, deduplicates, and sorts explicit targets", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		await createPackRoot(root, declared.authorRoot);
		const alpha = await createPackRoot(root, "served/alpha");
		const zulu = await createPackRoot(root, "served/zulu");
		const targets = await servingTargets(declared, ["served/zulu", "served/alpha", "served/alpha"], {
			projectRoot: root,
			caseInsensitive: true,
		});
		expect(targets.map((target: { path: string }) => target.path)).toEqual([await realpath(alpha), await realpath(zulu)]);
	});

	it("rejects a symlink alias of the authored root", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		const author = await createPackRoot(root, declared.authorRoot);
		await mkdir(path.join(root, "served"), { recursive: true });
		const alias = path.join(root, "served", "alias");
		try {
			await symlink(author, alias, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}
		await expect(servingTargets(declared, ["served/alias"], { projectRoot: root })).rejects.toThrow(
			"aliases the authored pack root",
		);
	});
});

describe("selected pack build and mirror", () => {
	it("builds only the selected declaration entries, sequentially, with production bundle invariants", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		const calls: Array<Record<string, unknown>> = [];
		let active = 0;
		let maxActive = 0;
		await buildSelectedPack(declared, {
			projectRoot: root,
			plugin: { name: "fixture", setup() {} },
			log() {},
			build: async (options: Record<string, unknown>) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				calls.push(options);
				await Promise.resolve();
				active -= 1;
			},
		});
		expect(maxActive).toBe(1);
		expect(calls).toHaveLength(2);
		expect(calls.map((call) => (call.entryPoints as string[])[0])).toEqual([
			path.join(root, declared.authorRoot, "src", "panel.ts"),
			path.join(root, declared.authorRoot, "src", "route.ts"),
		]);
		expect(calls.every((call) => call.splitting === false)).toBe(true);
		expect(calls.map((call) => call.platform)).toEqual(["browser", "node"]);
		expect(calls.map((call) => (call.plugins as Array<{ name: string }>).map((plugin) => plugin.name))).toEqual([
			["bobbit-pack-native-assets", "fixture"],
			["bobbit-pack-native-assets", "fixture"],
		]);
	});

	it("materializes and publishes the complete native matrix to every serving target, then removes stale output", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		const { author, packageRoot } = await createNativeBuildFixture(root, declared);
		const alpha = await createPackRoot(root, "served/alpha");
		const beta = await createPackRoot(root, "served/beta");
		const build = async (options: Record<string, unknown>) => {
			const outfile = options.outfile as string;
			await mkdir(path.dirname(outfile), { recursive: true });
			await writeFile(outfile, `bundle:${path.basename(outfile)}`);
		};
		const result = await buildSelectedPack(declared, {
			projectRoot: root,
			plugin: { name: "fixture", setup() {} },
			build,
			resolvePackageRoot: () => packageRoot,
			log() {},
		});
		const targets = await servingTargets(declared, ["served/beta", "served/alpha"], { projectRoot: root });
		await mirrorDeclaredOutputs(declared, targets, { projectRoot: root, nativeAssetFamilies: result.nativeAssetFamilies });

		const sourceFamily = path.join(author, "lib", "native", "database-driver");
		for (const served of [alpha, beta]) {
			const servedFamily = path.join(served, "lib", "native", "database-driver");
			expect((await readdir(servedFamily)).sort()).toEqual((await readdir(sourceFamily)).sort());
			for (const target of NATIVE_TARGETS) {
				expect(await readFile(path.join(servedFamily, `${target}.node`))).toEqual(await readFile(path.join(sourceFamily, `${target}.node`)));
			}
			expect(await readFile(path.join(servedFamily, "manifest.json"))).toEqual(await readFile(path.join(sourceFamily, "manifest.json")));
			await writeFile(path.join(servedFamily, "stale.node"), "stale");
		}

		await writeFile(path.join(author, "pack.build.json"), JSON.stringify({ schema: 1, nativeAssets: [] }));
		const withoutFamilies = await buildSelectedPack(declared, {
			projectRoot: root,
			plugin: { name: "fixture", setup() {} },
			build,
			resolvePackageRoot: () => packageRoot,
			log() {},
		});
		expect(withoutFamilies.nativeAssetFamilies).toEqual([]);
		await expect(lstat(sourceFamily)).rejects.toMatchObject({ code: "ENOENT" });
		await mirrorDeclaredOutputs(declared, targets, { projectRoot: root, nativeAssetFamilies: [] });
		for (const served of [alpha, beta]) {
			await expect(lstat(path.join(served, "lib", "native", "database-driver"))).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("rejects corrupt authored native bytes before publishing any family", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		const { author, packageRoot } = await createNativeBuildFixture(root, declared);
		const alpha = await createPackRoot(root, "served/alpha");
		const beta = await createPackRoot(root, "served/beta");
		const build = async (options: Record<string, unknown>) => {
			const outfile = options.outfile as string;
			await mkdir(path.dirname(outfile), { recursive: true });
			await writeFile(outfile, "bundle");
		};
		const result = await buildSelectedPack(declared, {
			projectRoot: root,
			plugin: { name: "fixture", setup() {} },
			build,
			resolvePackageRoot: () => packageRoot,
			log() {},
		});
		await writeFile(path.join(author, "lib", "native", "database-driver", "linux-glibc-x64.node"), "corrupt-after-build");
		const targets = await servingTargets(declared, ["served/alpha", "served/beta"], { projectRoot: root });

		await expect(mirrorDeclaredOutputs(declared, targets, {
			projectRoot: root,
			nativeAssetFamilies: result.nativeAssetFamilies,
		})).rejects.toThrow(/does not match manifest|linux-glibc-x64/i);
		for (const served of [alpha, beta]) {
			await expect(lstat(path.join(served, "lib", "native", "database-driver"))).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("rejects an atomic authored-family identity replacement without publishing mixed targets", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		const { author, packageRoot } = await createNativeBuildFixture(root, declared);
		const alpha = await createPackRoot(root, "served/alpha");
		const beta = await createPackRoot(root, "served/beta");
		const build = async (options: Record<string, unknown>) => {
			const outfile = options.outfile as string;
			await mkdir(path.dirname(outfile), { recursive: true });
			await writeFile(outfile, "bundle");
		};
		const result = await buildSelectedPack(declared, {
			projectRoot: root,
			plugin: { name: "fixture", setup() {} },
			build,
			resolvePackageRoot: () => packageRoot,
			log() {},
		});
		const family = path.join(author, "lib", "native", "database-driver");
		const replacement = path.join(author, "lib", "native", "replacement");
		const displaced = path.join(author, "lib", "native", "displaced");
		await mkdir(replacement);
		for (const name of await readdir(family)) await writeFile(path.join(replacement, name), await readFile(path.join(family, name)));
		const targets = await servingTargets(declared, ["served/alpha", "served/beta"], { projectRoot: root });
		let replaced = false;
		const fs = {
			copyFile, lstat, mkdir, readdir, realpath, rename, rmdir, unlink, writeFile,
			async readFile(filePath: string, ...args: any[]) {
				if (!replaced && filePath === path.join(family, "darwin-arm64.node")) {
					replaced = true;
					await rename(family, displaced);
					await rename(replacement, family);
				}
				return (readFile as any)(filePath, ...args);
			},
		};

		await expect(mirrorDeclaredOutputs(declared, targets, {
			projectRoot: root,
			nativeAssetFamilies: result.nativeAssetFamilies,
			fs,
		})).rejects.toMatchObject({ code: "ESTALE" });
		expect(replaced).toBe(true);
		for (const served of [alpha, beta]) {
			await expect(lstat(path.join(served, "lib", "native", "database-driver"))).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("removes stale files from a still-declared served native family", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		const { packageRoot } = await createNativeBuildFixture(root, declared);
		const served = await createPackRoot(root, "served/fixture");
		const build = async (options: Record<string, unknown>) => {
			const outfile = options.outfile as string;
			await mkdir(path.dirname(outfile), { recursive: true });
			await writeFile(outfile, "bundle");
		};
		const result = await buildSelectedPack(declared, {
			projectRoot: root,
			plugin: { name: "fixture", setup() {} },
			build,
			resolvePackageRoot: () => packageRoot,
			log() {},
		});
		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });
		await mirrorDeclaredOutputs(declared, targets, { projectRoot: root, nativeAssetFamilies: result.nativeAssetFamilies });
		const stale = path.join(served, "lib", "native", "database-driver", "stale.node");
		await writeFile(stale, "stale");

		await mirrorDeclaredOutputs(declared, targets, { projectRoot: root, nativeAssetFamilies: result.nativeAssetFamilies });
		await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("mirrors declared nested output paths without flattening or discovery", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		const author = await createBuiltOutputs(root, declared);
		const target = await createPackRoot(root, "served/fixture");
		await mkdir(path.join(target, "lib", "nested"), { recursive: true });
		await writeFile(path.join(target, "lib", "nested", "panel.js"), "panel-old");
		await writeFile(path.join(target, "lib", "route.mjs"), "route-old");
		await writeFile(path.join(author, "lib", "stale.js"), "must-not-mirror");

		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });
		await mirrorDeclaredOutputs(declared, targets, { projectRoot: root });
		expect(await readFile(path.join(target, "lib", "nested", "panel.js"), "utf8")).toBe("panel-current");
		expect(await readFile(path.join(target, "lib", "route.mjs"), "utf8")).toBe("route-current");
		await expect(readFile(path.join(target, "lib", "stale.js"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["EPERM", "EEXIST"])("replaces an existing Windows output after an eligible %s collision", async (code) => {
		const root = await fixtureRoot();
		const declared = { ...declaration(), entries: [{ in: "panel.ts", out: "lib/nested/panel.js" }] };
		await createBuiltOutputs(root, declared);
		const target = await createPackRoot(root, "served/fixture");
		const destination = path.join(target, "lib", "nested", "panel.js");
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, "panel-old");
		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });
		const realFs = { copyFile, lstat, mkdir, realpath, rename, unlink };
		let renameCalls = 0;
		const fs = {
			...realFs,
			async rename(from: string, to: string) {
				renameCalls += 1;
				if (renameCalls === 1) throw Object.assign(new Error(`injected ${code}`), { code });
				await rename(from, to);
			},
		};
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");

		await mirrorDeclaredOutputs(declared, targets, { projectRoot: root, fs });

		expect(renameCalls).toBe(2);
		expect(await readFile(destination, "utf8")).toBe("panel-current");
	});

	it.each(["EACCES", "EBUSY", "EIO"])("preserves an existing Windows output after an unrelated %s rename failure", async (code) => {
		const root = await fixtureRoot();
		const declared = { ...declaration(), entries: [{ in: "panel.ts", out: "lib/nested/panel.js" }] };
		await createBuiltOutputs(root, declared);
		const target = await createPackRoot(root, "served/fixture");
		const destination = path.join(target, "lib", "nested", "panel.js");
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, "panel-old");
		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });
		const realFs = { copyFile, lstat, mkdir, realpath, rename, unlink };
		const renameFailure = Object.assign(new Error(`injected ${code}`), { code });
		let tempPath: string | undefined;
		let renameCalls = 0;
		const fs = {
			...realFs,
			async rename(from: string, _to: string) {
				renameCalls += 1;
				tempPath = from;
				throw renameFailure;
			},
		};
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");

		await expect(mirrorDeclaredOutputs(declared, targets, { projectRoot: root, fs })).rejects.toBe(renameFailure);

		expect(renameCalls).toBe(1);
		expect(await readFile(destination, "utf8")).toBe("panel-old");
		expect(tempPath).toBeDefined();
		await expect(lstat(tempPath!)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a declared output parent symlink or junction without writing outside the target", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		await createBuiltOutputs(root, declared);
		await createPackRoot(root, "served/fixture");
		const outside = path.join(root, "outside-parent");
		await mkdir(outside);
		await createDirectoryLink(outside, path.join(root, "served/fixture/lib"));
		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });

		await expect(mirrorDeclaredOutputs(declared, targets, { projectRoot: root })).rejects.toThrow(
			"changed or is unsafe",
		);
		await expect(readFile(path.join(outside, "nested", "panel.js"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a final output symlink and leaves its external sentinel unchanged", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		await createBuiltOutputs(root, declared);
		const target = await createPackRoot(root, "served/fixture");
		const parent = path.join(target, "lib", "nested");
		await mkdir(parent, { recursive: true });
		const sentinel = path.join(root, "outside-sentinel.js");
		const destination = path.join(parent, "panel.js");
		await writeFile(sentinel, "sentinel-original");
		let fileLinkAvailable = true;
		try {
			await symlink(sentinel, destination, "file");
		} catch (error) {
			if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			fileLinkAvailable = false;
			await writeFile(destination, "existing-output");
		}
		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });
		const realFs = { copyFile, lstat, mkdir, realpath, rename, unlink };
		const fs = fileLinkAvailable ? realFs : {
			...realFs,
			async lstat(filePath: string) {
				const stats = await lstat(filePath);
				if (filePath !== destination) return stats;
				return { ...stats, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true };
			},
		};

		await expect(mirrorDeclaredOutputs(declared, targets, { projectRoot: root, fs })).rejects.toThrow(
			"not a stable regular file",
		);
		expect(await readFile(sentinel, "utf8")).toBe("sentinel-original");
	});

	it("rejects a native output parent symlink without writing outside the serving target", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		const { packageRoot } = await createNativeBuildFixture(root, declared);
		const served = await createPackRoot(root, "served/fixture");
		await mkdir(path.join(served, "lib"), { recursive: true });
		const outside = path.join(root, "outside-native");
		await mkdir(outside);
		await createDirectoryLink(outside, path.join(served, "lib", "native"));
		const build = async (options: Record<string, unknown>) => {
			const outfile = options.outfile as string;
			await mkdir(path.dirname(outfile), { recursive: true });
			await writeFile(outfile, "bundle");
		};
		const result = await buildSelectedPack(declared, {
			projectRoot: root,
			plugin: { name: "fixture", setup() {} },
			build,
			resolvePackageRoot: () => packageRoot,
			log() {},
		});
		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });

		await expect(mirrorDeclaredOutputs(declared, targets, {
			projectRoot: root,
			nativeAssetFamilies: result.nativeAssetFamilies,
		})).rejects.toThrow("changed or is unsafe");
		await expect(readdir(outside)).resolves.toEqual([]);
	});

	it("rejects a serving root identity replaced after validation without writing into the replacement", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		await createBuiltOutputs(root, declared);
		const target = await createPackRoot(root, "served/fixture");
		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });
		const displaced = path.join(root, "served/fixture-displaced");
		await rename(target, displaced);
		await mkdir(target);

		await expect(mirrorDeclaredOutputs(declared, targets, { projectRoot: root })).rejects.toMatchObject({ code: "ESTALE" });
		await expect(readFile(path.join(target, "lib", "nested", "panel.js"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects an output parent replaced after validation without mutating an outside sentinel", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		await createBuiltOutputs(root, declared);
		const target = await createPackRoot(root, "served/fixture");
		const parent = path.join(target, "lib");
		await mkdir(parent);
		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });
		await rename(parent, path.join(target, "lib-displaced"));
		const outside = path.join(root, "outside-parent-replacement");
		await mkdir(outside);
		await writeFile(path.join(outside, "sentinel"), "unchanged");
		await createDirectoryLink(outside, parent);

		await expect(mirrorDeclaredOutputs(declared, targets, { projectRoot: root })).rejects.toMatchObject({ code: "ESTALE" });
		expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged");
		await expect(readFile(path.join(outside, "nested", "panel.js"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("serialized pack rebuilds", () => {
	it("rejects and cleans up an initial failed cycle before reporting readiness", async () => {
		const root = await fixtureRoot();
		const declared = resolvePackBuild("file-explorer");
		await createPackRoot(root, declared.authorRoot, declared.pack);
		await mkdir(path.join(root, declared.authorRoot, "src"), { recursive: true });
		await createPackRoot(root, declared.defaultServingRoot, declared.pack);
		const signals = new EventEmitter();
		const watchers = [{ close: vi.fn() }, { close: vi.fn() }];
		const watch = vi.fn(() => watchers[watch.mock.calls.length - 1]);
		const mirror = vi.fn(async () => {});
		const notify = vi.fn(async () => {});
		const log = vi.fn();

		await expect(runWatcher(parseArgs(["--watch", declared.pack]), {
			projectRoot: root,
			watch,
			build: async () => { throw new Error("initial compile failed"); },
			mirror,
			notify,
			signalSource: signals,
			onError() {},
			log,
		})).rejects.toThrow("initial compile failed");

		expect(watch).toHaveBeenCalledTimes(2);
		expect(mirror).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
		expect(watchers[0].close).toHaveBeenCalledOnce();
		expect(watchers[1].close).toHaveBeenCalledOnce();
		expect(signals.listenerCount("SIGINT")).toBe(0);
		expect(signals.listenerCount("SIGTERM")).toBe(0);
	});

	it("watches source and adjacent metadata while ignoring generated lib changes", async () => {
		const root = await fixtureRoot();
		const declared = resolvePackBuild("file-explorer");
		await createPackRoot(root, declared.authorRoot, declared.pack);
		await mkdir(path.join(root, declared.authorRoot, "src"), { recursive: true });
		await createPackRoot(root, declared.defaultServingRoot, declared.pack);
		const registrations: Array<{ root: string; callback: (event: string, filename: string | null) => void; close: ReturnType<typeof vi.fn> }> = [];
		const watch = vi.fn((watchedRoot: string, _options: unknown, callback: (event: string, filename: string | null) => void) => {
			const registration = { root: watchedRoot, callback, close: vi.fn() };
			registrations.push(registration);
			return registration;
		});
		const build = vi.fn(async () => ({ nativeAssetFamilies: [] }));
		const mirror = vi.fn(async () => {});
		const notify = vi.fn(async () => {});
		const rebuilder = await runWatcher(parseArgs(["--watch", declared.pack]), {
			projectRoot: root,
			watch,
			build,
			mirror,
			notify,
			signalSource: new EventEmitter(),
			log() {},
		});
		expect(registrations.map((registration) => registration.root)).toEqual([
			path.join(root, declared.authorRoot, "src"),
			path.join(root, declared.authorRoot),
		]);
		expect(build).toHaveBeenCalledOnce();

		registrations[1].callback("rename", "lib");
		await rebuilder.flush();
		expect(build).toHaveBeenCalledOnce();
		registrations[1].callback("rename", null);
		await rebuilder.flush();
		expect(build).toHaveBeenCalledTimes(2);
		registrations[1].callback("change", "pack.build.json");
		await rebuilder.flush();
		expect(build).toHaveBeenCalledTimes(3);
		registrations[0].callback("change", "route.ts");
		await rebuilder.flush();
		expect(build).toHaveBeenCalledTimes(4);
		await rebuilder.dispose();
		expect(registrations.every((registration) => registration.close.mock.calls.length === 1)).toBe(true);
	});

	it("does not mirror or notify after a later failed build and remains usable", async () => {
		let shouldFail = false;
		const mirror = vi.fn(async () => {});
		const notify = vi.fn(async () => {});
		const rebuilder = createSerializedRebuilder({
			pack: "fixture",
			build: async () => { if (shouldFail) throw new Error("compile failed"); },
			mirror,
			notify,
			onError() {},
		});
		rebuilder.schedule(true);
		await rebuilder.flush();
		mirror.mockClear();
		notify.mockClear();

		shouldFail = true;
		rebuilder.schedule(true);
		await rebuilder.flush();
		expect(mirror).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();

		shouldFail = false;
		rebuilder.schedule(true);
		await rebuilder.flush();
		expect(mirror).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith({ pack: "fixture", reloadToken: 2 });
	});

	it("does not notify for an unsafe mirror and recovers after the target is repaired", async () => {
		const root = await fixtureRoot();
		const declared = declaration();
		await createBuiltOutputs(root, declared);
		const target = await createPackRoot(root, "served/fixture");
		const outside = path.join(root, "outside-rebuilder");
		await mkdir(outside);
		const unsafeParent = path.join(target, "lib");
		await createDirectoryLink(outside, unsafeParent);
		const targets = await servingTargets(declared, ["served/fixture"], { projectRoot: root });
		const notify = vi.fn(async () => {});
		const rebuilder = createSerializedRebuilder({
			pack: "fixture",
			build: async () => {},
			mirror: () => mirrorDeclaredOutputs(declared, targets, { projectRoot: root }),
			notify,
			onError() {},
		});

		rebuilder.schedule(true);
		await rebuilder.flush();
		expect(notify).not.toHaveBeenCalled();
		await expect(readFile(path.join(outside, "nested", "panel.js"))).rejects.toMatchObject({ code: "ENOENT" });

		await unlink(unsafeParent);
		await mkdir(unsafeParent);
		rebuilder.schedule(true);
		await rebuilder.flush();
		expect(await readFile(path.join(target, "lib", "nested", "panel.js"), "utf8")).toBe("panel-current");
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith({ pack: "fixture", reloadToken: 1 });
	});

	it("publishes once per pack-level cycle and coalesces concurrent events into one trailing cycle", async () => {
		let active = 0;
		let maxActive = 0;
		let releaseFirst!: () => void;
		const firstBuild = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let builds = 0;
		const notify = vi.fn(async (_payload: { pack: string; reloadToken: number }) => {});
		const rebuilder = createSerializedRebuilder({
			pack: "fixture",
			build: async () => {
				builds += 1;
				active += 1;
				maxActive = Math.max(maxActive, active);
				if (builds === 1) await firstBuild;
				active -= 1;
			},
			mirror: async () => {},
			notify,
			onError() {},
		});
		rebuilder.schedule(true);
		await vi.waitFor(() => expect(builds).toBe(1));
		rebuilder.schedule();
		rebuilder.schedule();
		rebuilder.schedule();
		releaseFirst();
		await rebuilder.flush();
		expect(builds).toBe(2);
		expect(maxActive).toBe(1);
		expect(notify.mock.calls.map(([payload]) => payload.reloadToken)).toEqual([1, 2]);
	});

	it("does not expose a failed delivery token and retries with a newer token after a later event", async () => {
		const delivered: number[] = [];
		let attempt = 0;
		const rebuilder = createSerializedRebuilder({
			pack: "fixture",
			build: async () => {},
			mirror: async () => {},
			notify: async ({ reloadToken }: { reloadToken: number }) => {
				attempt += 1;
				if (attempt === 1) throw new Error("Vite unavailable");
				delivered.push(reloadToken);
			},
			onError() {},
		});
		rebuilder.schedule(true);
		await rebuilder.flush();
		expect(delivered).toEqual([]);
		rebuilder.schedule(true);
		await rebuilder.flush();
		expect(delivered).toEqual([2]);
	});

	it("disposes during debounce or an active build and cleans watcher/signal listeners idempotently", async () => {
		const signals = new EventEmitter();
		const watcher = { close: vi.fn() };
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const build = vi.fn(async () => { await blocked; });
		const rebuilder = createSerializedRebuilder({
			pack: "fixture",
			build,
			mirror: async () => {},
			notify: async () => {},
			debounceMs: 10_000,
			signalSource: signals,
			onError() {},
		});
		rebuilder.attachWatcher(watcher);
		rebuilder.schedule();
		await rebuilder.dispose();
		expect(build).not.toHaveBeenCalled();
		expect(watcher.close).toHaveBeenCalledOnce();
		expect(signals.listenerCount("SIGINT")).toBe(0);
		expect(signals.listenerCount("SIGTERM")).toBe(0);
		await rebuilder.dispose();
		expect(watcher.close).toHaveBeenCalledOnce();

		const active = createSerializedRebuilder({
			pack: "fixture",
			build,
			mirror: async () => {},
			notify: async () => {},
			onError() {},
		});
		active.schedule(true);
		await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
		const disposal = active.dispose();
		release();
		await disposal;
		expect(active.state.closed).toBe(true);
	});
});

describe("Vite notification", () => {
	it("posts the exact tokenized payload and accepts only HTTP 204", async () => {
		const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => ({ status: 204 }));
		await notifyVite("http://127.0.0.1:5173/base", { pack: "fixture", reloadToken: 7 }, { fetch: fetchMock });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://127.0.0.1:5173/__bobbit_dev/pack-rebuilt");
		expect(init).toMatchObject({
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Bobbit-Pack-Reload": "1",
			},
			body: '{"pack":"fixture","reloadToken":7}',
		});
		await expect(notifyVite("http://127.0.0.1:5173", { pack: "fixture", reloadToken: 8 }, {
			fetch: async () => ({ status: 200 }),
		})).rejects.toThrow("HTTP 200");
	});

	it("bounds a stalled Vite request with a timeout", async () => {
		const stalledFetch = (_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		});
		await expect(notifyVite("http://127.0.0.1:5173", { pack: "fixture", reloadToken: 1 }, {
			fetch: stalledFetch,
			timeoutMs: 5,
		})).rejects.toThrow("timed out after 5ms");
	});
});
