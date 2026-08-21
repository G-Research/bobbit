import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPackContributions, type PackContributions } from "../../src/server/agent/pack-contributions.js";
import { validateManifest } from "../../src/server/agent/pack-manifest.js";
import type { PackEntry, PackLocalDataDeclaration, PackManifest } from "../../src/server/agent/pack-types.js";
import { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.js";
import {
	PACK_LOCAL_DATA_CONTAINER_ROOT,
	PackLocalDataError,
	PackLocalDataResolver,
} from "../../src/server/extension-host/pack-local-data.js";

const fixtures: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

const baseManifest = {
	name: "performance",
	description: "Performance tools",
	version: "1.0.0",
	contents: { roles: [], tools: [], skills: [] },
};

const declaration: PackLocalDataDeclaration = {
	scope: "project",
	directory: ".performance-optimisation/cache",
	access: "read-write",
	preserveOnUninstall: true,
};

function manifest(localData?: PackLocalDataDeclaration): PackManifest {
	return {
		...baseManifest,
		schema: 2,
		contents: { ...baseManifest.contents, entrypoints: [] },
		...(localData ? { localData } : {}),
	};
}

function contribution(packId: string, localData?: PackLocalDataDeclaration): PackContributions {
	return {
		packId,
		packName: packId,
		packRoot: path.join("packs", packId),
		panels: [],
		entrypoints: [],
		providers: [],
		channels: [],
		hooks: [],
		mcp: [],
		...(localData ? { localData } : {}),
	};
}

function fixtureRoot(): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pack-local-data-")));
	fixtures.push(root);
	return root;
}

function resolverFor(
	projectRoot: string,
	packs: PackContributions[],
	managedMarketplaceRoots: () => readonly string[] = () => [],
): PackLocalDataResolver {
	return new PackLocalDataResolver(
		{ get: id => id === "project-1" ? ({ id, rootPath: projectRoot } as never) : undefined },
		{
			getPack: (projectId, packId) => projectId === "project-1" ? packs.find(pack => pack.packId === packId) : undefined,
			list: projectId => projectId === "project-1" ? packs : [],
		},
		managedMarketplaceRoots,
	);
}

function relativeDeclaration(projectRoot: string, target: string): PackLocalDataDeclaration {
	return {
		...declaration,
		directory: path.relative(projectRoot, target).split(path.sep).join("/"),
	};
}

describe("pack local-data manifest declaration", () => {
	it("accepts and normalizes the fixed schema-2 declaration", () => {
		const parsed = validateManifest({ ...baseManifest, schema: 2, localData: declaration });
		expect(parsed?.localData).toEqual(declaration);
	});

	it("preserves the no-declaration and schema-1 object shape", () => {
		const schema2 = validateManifest({ ...baseManifest, schema: 2 })!;
		expect(Object.hasOwn(schema2, "localData")).toBe(false);
		const schema1 = validateManifest({
			...baseManifest,
			localData: { ...declaration, directory: "../ignored-for-schema-1" },
		})!;
		expect(Object.hasOwn(schema1, "localData")).toBe(false);
	});

	it.each([
		"", " spaced", "spaced ", "/absolute", "//server/share", "C:\\absolute",
		"C:drive-relative", "\\\\server\\share", "with\\backslash", ".", "..",
		"a/./b", "a/../b", "a//b", "CON", "con.txt", "nested/COM1.log", "COM¹",
		"trailing.", "trailing ", "ads:name", "question?mark", "with\0nul",
	])("rejects non-portable directory %j", directory => {
		const problems: string[] = [];
		expect(validateManifest({
			...baseManifest,
			schema: 2,
			localData: { ...declaration, directory },
		}, problems)).toBeNull();
		expect(problems.join("; ")).toMatch(/localData/);
	});

	it.each([
		".bobbit/config/market-packs",
		".bobbit/config/market-packs/performance",
		"config/market-packs",
		"config/market-packs/performance/cache",
		".BOBBIT/CONFIG/MARKET-PACKS/Performance",
		"Config/Market-Packs/performance",
	])("rejects Bobbit-managed marketplace directory %j", directory => {
		expect(validateManifest({
			...baseManifest,
			schema: 2,
			localData: { ...declaration, directory },
		})).toBeNull();
	});

	it.each([
		".performance-optimisation",
		".bobbit/config/market-pack",
		".bobbit/config/market-packs-data",
		"config/market-pack",
		"data/config/market-packs/performance",
	])("accepts external or near-miss directory %j", directory => {
		expect(validateManifest({
			...baseManifest,
			schema: 2,
			localData: { ...declaration, directory },
		})?.localData?.directory).toBe(directory);
	});

	it("requires every fixed lifecycle/access field", () => {
		for (const localData of [
			{ ...declaration, scope: "user" },
			{ ...declaration, access: "read-only" },
			{ ...declaration, preserveOnUninstall: false },
			{ directory: declaration.directory },
		]) {
			expect(validateManifest({ ...baseManifest, schema: 2, localData })).toBeNull();
		}
	});

	it("copies only declared local data into contribution objects", () => {
		const root = path.join(fixtureRoot(), "market-packs", "performance");
		fs.mkdirSync(root, { recursive: true });
		const without = loadPackContributions(root, manifest());
		expect(Object.hasOwn(without, "localData")).toBe(false);
		expect(loadPackContributions(root, manifest(declaration)).localData).toEqual(declaration);
	});

	it("exposes only the winning pack declaration through the contribution registry", () => {
		const fixture = fixtureRoot();
		const lowerRoot = path.join(fixture, "global", "market-packs", "performance");
		const winnerRoot = path.join(fixture, "project", "market-packs", "performance");
		fs.mkdirSync(lowerRoot, { recursive: true });
		fs.mkdirSync(winnerRoot, { recursive: true });
		const lower = manifest({ ...declaration, directory: "global-data" });
		const winner = manifest({ ...declaration, directory: "project-data" });
		const entry = (packPath: string, scope: PackEntry["scope"], packManifest: PackManifest): PackEntry => ({
			id: `market:${scope}:performance`, kind: "market", scope, path: packPath,
			readOnly: false, manifest: packManifest, layout: "defaults-tree",
		});
		const registry = new PackContributionRegistry(() => [
			entry(lowerRoot, "global-user", lower),
			entry(winnerRoot, "project", winner),
		]);
		expect(registry.getPack("project-1", "performance")?.localData?.directory).toBe("project-data");
	});
});

describe("PackLocalDataResolver", () => {
	it("materializes below the registered canonical project root, independent of worktrees", () => {
		const root = fixtureRoot();
		const resolver = resolverFor(root, [contribution("performance", declaration)]);
		const expected = path.join(root, ".performance-optimisation", "cache");

		expect(resolver.resolveHostDirectory("project-1", "performance")).toBe(expected);
		expect(fs.statSync(expected).isDirectory()).toBe(true);
		// The API has no cwd/worktree coordinate: repeated realm adapters resolve the same root binding.
		expect(resolver.resolveHostDirectory("project-1", "performance")).toBe(expected);
	});

	it("uses the registered polyrepo container root rather than a component root", () => {
		const root = fixtureRoot();
		fs.mkdirSync(path.join(root, "components", "web"), { recursive: true });
		const resolver = resolverFor(root, [contribution("performance", declaration)]);
		expect(resolver.resolveHostDirectory("project-1", "performance"))
			.toBe(path.join(root, ".performance-optimisation", "cache"));
	});

	it("rejects links and non-directory components even when they remain in-root", () => {
		const root = fixtureRoot();
		const real = path.join(root, "real-data");
		const link = path.join(root, "linked-data");
		fs.mkdirSync(real);
		let linked = false;
		try {
			fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
			linked = true;
		} catch (error: any) {
			if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error?.code)) throw error;
			fs.mkdirSync(link);
		}
		const linkedDeclaration = { ...declaration, directory: "linked-data/child" };
		const resolver = resolverFor(root, [contribution("performance", linkedDeclaration)]);
		if (!linked) {
			const realLstat = fs.lstatSync.bind(fs);
			vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike) => {
				const stat = realLstat(candidate);
				return path.resolve(String(candidate)) === path.resolve(link)
					? ({ ...stat, isSymbolicLink: () => true } as fs.Stats)
					: stat;
			}) as typeof fs.lstatSync);
		}
		expect(() => resolver.resolveHostDirectory("project-1", "performance"))
			.toThrowError(expect.objectContaining({ code: "path_is_link" }));

		const file = path.join(root, "file-component");
		fs.writeFileSync(file, "not a directory");
		const fileResolver = resolverFor(root, [contribution("file-pack", { ...declaration, directory: "file-component/child" })]);
		expect(() => fileResolver.resolveHostDirectory("project-1", "file-pack"))
			.toThrowError(expect.objectContaining({ code: "path_not_directory" }));
	});

	it("returns sorted host/container mount plans and performs no work for undeclared packs", () => {
		const root = fixtureRoot();
		const resolver = resolverFor(root, [
			contribution("z-pack", { ...declaration, directory: "z-data" }),
			contribution("undeclared"),
			contribution("a/pack", { ...declaration, directory: "a-data" }),
		]);
		expect(resolver.resolveMounts("project-1")).toEqual([
			{
				packId: "a/pack",
				hostDirectory: path.join(root, "a-data"),
				containerDirectory: `${PACK_LOCAL_DATA_CONTAINER_ROOT}/a%2Fpack`,
			},
			{
				packId: "z-pack",
				hostDirectory: path.join(root, "z-data"),
				containerDirectory: `${PACK_LOCAL_DATA_CONTAINER_ROOT}/z-pack`,
			},
		]);
		expect(fs.existsSync(path.join(root, "undeclared"))).toBe(false);
	});

	describe("managed Marketplace overlap guard", () => {
		it("rejects a parent project's candidate equal to or below Headquarters config/market-packs", () => {
			const root = fixtureRoot();
			const managedRoot = path.join(root, "simulated-headquarters", "config", "market-packs");
			const descendant = path.join(managedRoot, "performance", "cache");
			fs.mkdirSync(managedRoot, { recursive: true });
			const resolver = resolverFor(root, [
				contribution("equal", relativeDeclaration(root, managedRoot)),
				contribution("descendant", relativeDeclaration(root, descendant)),
			], () => [managedRoot]);

			for (const packId of ["equal", "descendant"]) {
				expect(() => resolver.resolveHostDirectory("project-1", packId))
					.toThrowError(expect.objectContaining({ code: "unsafe_path" }));
			}
			expect(fs.existsSync(descendant)).toBe(false);
		});

		it("rejects global-user and another registered child project's managed roots", () => {
			const parentRoot = fixtureRoot();
			const registeredProjects = new Map([
				["project-1", parentRoot],
				["child-project", path.join(parentRoot, "registered-child")],
			]);
			const globalUserRoot = path.join(parentRoot, "simulated-global-user");
			const globalMarketplaceRoot = path.join(globalUserRoot, ".bobbit", "config", "market-packs");
			const childMarketplaceRoot = path.join(
				registeredProjects.get("child-project")!,
				".bobbit", "config", "market-packs",
			);
			const resolver = resolverFor(parentRoot, [
				contribution("global", relativeDeclaration(parentRoot, path.join(globalMarketplaceRoot, "global-pack"))),
				contribution("child", relativeDeclaration(parentRoot, path.join(childMarketplaceRoot, "child-pack"))),
			], () => [
				globalMarketplaceRoot,
				...Array.from(registeredProjects.values(), projectRoot =>
					path.join(projectRoot, ".bobbit", "config", "market-packs")),
			]);

			for (const packId of ["global", "child"]) {
				expect(() => resolver.resolveHostDirectory("project-1", packId))
					.toThrowError(expect.objectContaining({ code: "unsafe_path" }));
			}
			expect(fs.existsSync(globalUserRoot)).toBe(false);
			expect(fs.existsSync(registeredProjects.get("child-project")!)).toBe(false);
		});

		it.each(["resolveHostDirectory", "resolveMounts"] as const)(
			"%s rejects an absent managed root before creating its first component",
			api => {
				const root = fixtureRoot();
				const firstComponent = path.join(root, "future-headquarters");
				const managedRoot = path.join(firstComponent, "config", "market-packs");
				const resolver = resolverFor(root, [
					contribution("performance", relativeDeclaration(root, path.join(managedRoot, "performance"))),
				], () => [managedRoot]);

				const resolve = api === "resolveHostDirectory"
					? () => resolver.resolveHostDirectory("project-1", "performance")
					: () => resolver.resolveMounts("project-1");
				expect(resolve).toThrowError(expect.objectContaining({ code: "unsafe_path" }));
				expect(fs.existsSync(firstComponent)).toBe(false);
			},
		);

		it("allows a nearby non-overlapping directory", () => {
			const root = fixtureRoot();
			const managedRoot = path.join(root, "simulated-headquarters", "config", "market-packs");
			const nearby = path.join(root, "simulated-headquarters", "config", "market-packs-data", "cache");
			const resolver = resolverFor(root, [
				contribution("performance", relativeDeclaration(root, nearby)),
			], () => [managedRoot]);

			expect(resolver.resolveHostDirectory("project-1", "performance")).toBe(nearby);
			expect(fs.statSync(nearby).isDirectory()).toBe(true);
		});

		it("normalizes path spellings and applies deterministic Windows case folding", () => {
			const root = fixtureRoot();
			const candidate = path.join(root, "Headquarters", "config", "market-packs", "cache");
			const managedRoot = [
				root,
				"headquarters",
				"config",
				"ignored",
				"..",
				"market-packs",
			].join(path.sep);
			vi.spyOn(process, "platform", "get").mockReturnValue("win32");
			const resolver = resolverFor(root, [
				contribution("performance", relativeDeclaration(root, candidate)),
			], () => [managedRoot]);

			expect(() => resolver.resolveHostDirectory("project-1", "performance"))
				.toThrowError(expect.objectContaining({ code: "unsafe_path" }));
			expect(fs.existsSync(path.join(root, "Headquarters"))).toBe(false);
		});

		it("reads the managed-roots provider on every resolution", () => {
			const root = fixtureRoot();
			const lateManagedRoot = path.join(root, "late-project", ".bobbit", "config", "market-packs");
			let managedRoots: readonly string[] = [];
			const provider = vi.fn(() => managedRoots);
			const resolver = resolverFor(root, [
				contribution("ordinary", { ...declaration, directory: "ordinary-data" }),
				contribution("late", relativeDeclaration(root, path.join(lateManagedRoot, "late-pack"))),
			], provider);

			expect(resolver.resolveHostDirectory("project-1", "ordinary"))
				.toBe(path.join(root, "ordinary-data"));
			managedRoots = [lateManagedRoot];
			expect(() => resolver.resolveHostDirectory("project-1", "late"))
				.toThrowError(expect.objectContaining({ code: "unsafe_path" }));
			expect(provider).toHaveBeenCalledTimes(2);
			expect(fs.existsSync(path.join(root, "late-project"))).toBe(false);
		});
	});

	it("fails closed for unknown projects, inactive packs, and undeclared packs", () => {
		const root = fixtureRoot();
		const resolver = resolverFor(root, [contribution("bare")]);
		const assertCode = (run: () => unknown, code: PackLocalDataError["code"]) => {
			try {
				run();
				throw new Error("expected PackLocalDataError");
			} catch (error) {
				expect(error).toBeInstanceOf(PackLocalDataError);
				expect((error as PackLocalDataError).code).toBe(code);
			}
		};
		assertCode(() => resolver.resolveHostDirectory("missing", "bare"), "project_not_found");
		assertCode(() => resolver.resolveHostDirectory("project-1", "missing"), "pack_not_active");
		assertCode(() => resolver.resolveHostDirectory("project-1", "bare"), "local_data_undeclared");
	});
});
