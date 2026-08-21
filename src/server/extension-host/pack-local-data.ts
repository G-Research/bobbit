import fs from "node:fs";
import path from "node:path";
import { normalizePackLocalDataDirectory } from "../agent/pack-manifest.js";
import type { PackContributions } from "../agent/pack-contributions.js";
import type { PackLocalDataDeclaration } from "../agent/pack-types.js";
import { isPackPathWithinRoot } from "./path-guard.js";

export const PACK_LOCAL_DATA_CONTAINER_ROOT = "/bobbit/local-data";

export interface PackLocalDataMount {
	packId: string;
	hostDirectory: string;
	containerDirectory: string;
}

export interface PackLocalDataProjectRegistry {
	get(projectId: string): { rootPath: string } | undefined;
}

export interface PackLocalDataContributionRegistry {
	getPack(projectId: string | undefined, packId: string): PackContributions | undefined;
	list(projectId: string | undefined): PackContributions[];
}

/** Live view of every Marketplace directory whose children uninstall may remove. */
export type ManagedMarketplaceRootsProvider = () => readonly string[];

export type PackLocalDataErrorCode =
	| "project_not_found"
	| "pack_not_active"
	| "local_data_undeclared"
	| "invalid_declaration"
	| "invalid_project_root"
	| "unsafe_path"
	| "path_not_directory"
	| "path_is_link"
	| "filesystem_error";

/** A location-binding failure. Adapters decide how to project it to their realm. */
export class PackLocalDataError extends Error {
	constructor(
		public readonly code: PackLocalDataErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "PackLocalDataError";
	}
}

/** Stable sandbox projection. Pack identity is encoded as one path component. */
export function packLocalDataContainerDirectory(packId: string): string {
	if (!packId) throw new PackLocalDataError("pack_not_active", "Pack identity is required");
	let encoded: string;
	try {
		encoded = encodeURIComponent(packId).replace(/[.!'()*]/g, character =>
			`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
		);
	} catch (cause) {
		throw new PackLocalDataError("pack_not_active", "Pack identity cannot be encoded", { cause });
	}
	return path.posix.join(PACK_LOCAL_DATA_CONTAINER_ROOT, encoded);
}

/**
 * Stateless resolver for an active winning pack's project-local data binding.
 * It never infers project identity from cwd/worktrees and never caches paths.
 */
export class PackLocalDataResolver {
	constructor(
		private readonly projects: PackLocalDataProjectRegistry,
		private readonly contributions: PackLocalDataContributionRegistry,
		private readonly managedMarketplaceRoots: ManagedMarketplaceRootsProvider = () => [],
	) {}

	resolveHostDirectory(projectId: string, packId: string): string {
		const project = this.projects.get(projectId);
		if (!project) {
			throw new PackLocalDataError("project_not_found", `Unknown project: ${projectId}`);
		}
		const pack = this.contributions.getPack(projectId, packId);
		if (!pack) {
			throw new PackLocalDataError("pack_not_active", `Pack is not active: ${packId}`);
		}
		if (!pack.localData) {
			throw new PackLocalDataError("local_data_undeclared", `Pack does not declare local data: ${packId}`);
		}
		return this.materialize(project.rootPath, pack.localData);
	}

	resolveContainerDirectory(packId: string): string {
		return packLocalDataContainerDirectory(packId);
	}

	/** Resolve all active declarations to deterministic writable mount plans. */
	resolveMounts(projectId: string): PackLocalDataMount[] {
		const project = this.projects.get(projectId);
		if (!project) {
			throw new PackLocalDataError("project_not_found", `Unknown project: ${projectId}`);
		}
		return this.contributions.list(projectId)
			.filter((pack): pack is typeof pack & { localData: PackLocalDataDeclaration } => pack.localData !== undefined)
			.map(pack => ({
				packId: pack.packId,
				hostDirectory: this.materialize(project.rootPath, pack.localData),
				containerDirectory: packLocalDataContainerDirectory(pack.packId),
			}))
			.sort((a, b) => a.packId.localeCompare(b.packId));
	}

	private materialize(projectRoot: string, declaration: PackLocalDataDeclaration): string {
		const normalized = normalizePackLocalDataDirectory(declaration.directory);
		if (
			declaration.scope !== "project"
			|| normalized === null
			|| declaration.access !== "read-write"
			|| declaration.preserveOnUninstall !== true
		) {
			throw new PackLocalDataError("invalid_declaration", "Pack local-data declaration is invalid");
		}
		if (!path.isAbsolute(projectRoot)) {
			throw new PackLocalDataError("invalid_project_root", "Registered project root is not absolute");
		}

		let rootReal: string;
		try {
			rootReal = fs.realpathSync(projectRoot);
			if (!fs.lstatSync(rootReal).isDirectory()) {
				throw new PackLocalDataError("invalid_project_root", "Registered project root is not a directory");
			}
		} catch (cause) {
			if (cause instanceof PackLocalDataError) throw cause;
			throw new PackLocalDataError("invalid_project_root", "Registered project root is unavailable", { cause });
		}

		// Marketplace uninstall recursively removes an installed pack directory. A
		// registered project may be an ancestor of Headquarters, the user's home,
		// or another registered project, so the manifest-only relative-prefix guard
		// cannot see every managed pack tree. Reject the fully resolved candidate
		// against the live roots before creating even its first component.
		const candidate = path.resolve(rootReal, ...normalized.split("/"));
		this.assertOutsideManagedMarketplaceRoots(candidate);

		let current = rootReal;
		for (const component of normalized.split("/")) {
			const candidate = path.join(current, component);
			let stat = this.lstat(candidate);
			if (!stat) {
				try {
					fs.mkdirSync(candidate);
				} catch (cause: any) {
					// Concurrent resolvers may have created the same component.
					if (cause?.code !== "EEXIST") {
						throw new PackLocalDataError("filesystem_error", "Could not create pack local-data directory", { cause });
					}
				}
				stat = this.lstat(candidate);
			}
			if (!stat) {
				throw new PackLocalDataError("filesystem_error", "Pack local-data directory disappeared during creation");
			}
			if (stat.isSymbolicLink()) {
				throw new PackLocalDataError("path_is_link", "Pack local-data path contains a symbolic link or junction");
			}
			if (!stat.isDirectory()) {
				throw new PackLocalDataError("path_not_directory", "Pack local-data path contains a non-directory component");
			}

			let candidateReal: string;
			try {
				candidateReal = fs.realpathSync(candidate);
			} catch (cause) {
				throw new PackLocalDataError("filesystem_error", "Could not canonicalize pack local-data directory", { cause });
			}
			if (process.platform === "win32" && !sameWindowsPath(candidate, candidateReal)) {
				throw new PackLocalDataError("path_is_link", "Pack local-data path contains a reparse-point redirect");
			}
			if (!isPackPathWithinRoot(rootReal, candidateReal)) {
				throw new PackLocalDataError("unsafe_path", "Pack local-data directory escapes the registered project root");
			}
			current = candidateReal;
		}
		return current;
	}

	private assertOutsideManagedMarketplaceRoots(candidate: string): void {
		let managedRoots: readonly string[];
		try {
			managedRoots = this.managedMarketplaceRoots();
		} catch (cause) {
			throw new PackLocalDataError("filesystem_error", "Could not enumerate managed Marketplace roots", { cause });
		}

		const candidateVariants = absolutePathVariants(candidate);
		for (const managedRoot of managedRoots) {
			let rootVariants: string[];
			try {
				rootVariants = absolutePathVariants(managedRoot);
			} catch (cause) {
				if (cause instanceof PackLocalDataError) throw cause;
				throw new PackLocalDataError("filesystem_error", "Could not inspect a managed Marketplace root", { cause });
			}
			if (rootVariants.some(root => candidateVariants.some(variant => isEqualOrDescendant(root, variant)))) {
				throw new PackLocalDataError(
					"unsafe_path",
					"Pack local-data directory overlaps a Bobbit-managed Marketplace root",
				);
			}
		}
	}

	private lstat(candidate: string): fs.Stats | undefined {
		try {
			return fs.lstatSync(candidate);
		} catch (cause: any) {
			if (cause?.code === "ENOENT") return undefined;
			throw new PackLocalDataError("filesystem_error", "Could not inspect pack local-data directory", { cause });
		}
	}
}

/** Native lexical spelling plus its canonical spelling when the path exists. */
function absolutePathVariants(value: string): string[] {
	const absolute = path.resolve(value);
	const variants = [absolute];
	try {
		const real = fs.realpathSync(absolute);
		if (!sameNativePath(absolute, real)) variants.push(real);
	} catch (cause: any) {
		if (cause?.code !== "ENOENT" && cause?.code !== "ENOTDIR") {
			throw new PackLocalDataError("filesystem_error", "Could not canonicalize a managed Marketplace path", { cause });
		}
	}
	return variants;
}

function isEqualOrDescendant(root: string, candidate: string): boolean {
	const rootKey = nativePathKey(root);
	const candidateKey = nativePathKey(candidate);
	if (candidateKey === rootKey) return true;
	const prefix = rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`;
	return candidateKey.startsWith(prefix);
}

function nativePathKey(value: string): string {
	const normalized = path.normalize(path.resolve(value));
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameNativePath(left: string, right: string): boolean {
	return nativePathKey(left) === nativePathKey(right);
}

function sameWindowsPath(left: string, right: string): boolean {
	return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}
