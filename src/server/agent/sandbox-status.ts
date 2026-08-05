import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";

interface BinaryVersionsManifest {
	astGrep?: unknown;
}

function getPinnedAstGrepVersion(): string | null {
	try {
		const moduleDir = path.dirname(fileURLToPath(import.meta.url));
		const manifestPath = path.resolve(moduleDir, "../../..", "binaries.versions.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as BinaryVersionsManifest;
		return typeof manifest.astGrep === "string" && manifest.astGrep.length > 0 ? manifest.astGrep : null;
	} catch {
		return null;
	}
}

export interface SandboxStatus {
	available: boolean;
	error?: string;
	dockerVersion?: string;
	imageExists?: boolean;
	dockerfileExists?: boolean;
	buildCommand?: string;
	pool?: { total: number; idle: number; claimed: number; warming: number };
}

let _building = false;

export function isBuildingImage(): boolean {
	return _building;
}

function hasSandboxDockerfile(root: string): boolean {
	return fs.existsSync(path.join(root, "docker", "Dockerfile"));
}

function ancestors(start: string): string[] {
	const out: string[] = [];
	let current = path.resolve(start);
	while (true) {
		out.push(current);
		const parent = path.dirname(current);
		if (parent === current) return out;
		current = parent;
	}
}

/**
 * Locate Bobbit's bundled Docker sandbox context.
 *
 * Sandbox images are a Bobbit runtime artifact, not a user-project artifact.
 * Manual integration tests often register temp git repos that do not contain
 * `docker/Dockerfile`; rebuilding from those repos leaves a stale image in use.
 */
export function resolveSandboxDockerContext(preferredRoot?: string): string | null {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		...ancestors(moduleDir),
		...ancestors(process.cwd()),
		...(preferredRoot ? ancestors(preferredRoot) : []),
	];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const root = path.resolve(candidate);
		if (seen.has(root)) continue;
		seen.add(root);
		if (hasSandboxDockerfile(root)) return root;
	}
	return null;
}

export async function buildSandboxImage(imageName: string, dockerContextRoot?: string, commandRunner: CommandRunner = realCommandRunner): Promise<{ success: boolean; error?: string }> {
	const contextRoot = resolveSandboxDockerContext(dockerContextRoot);
	if (!contextRoot) {
		const error = "Dockerfile not found at docker/Dockerfile";
		console.error(`[sandbox] Failed to build Docker image "${imageName}": ${error}`);
		return { success: false, error };
	}

	_building = true;
	try {
		console.log(`[sandbox] Building Docker image "${imageName}" from ${path.join(contextRoot, "docker", "Dockerfile")}...`);
		const astGrepVersion = getPinnedAstGrepVersion();
		const args = ["build"];
		if (astGrepVersion) args.push("--build-arg", `AST_GREP_VERSION=${astGrepVersion}`);
		args.push("-t", imageName, path.join(contextRoot, "docker"));
		await commandRunner.execFile("docker", args, { cwd: contextRoot, timeout: 300_000 });
		console.log(`[sandbox] Docker image "${imageName}" built successfully`);
		return { success: true };
	} catch (err: any) {
		const errorMsg = err.stderr || err.message || String(err);
		console.error(`[sandbox] Failed to build Docker image "${imageName}": ${errorMsg}`);
		return { success: false, error: errorMsg };
	} finally {
		_building = false;
	}
}

export interface SandboxImageVersions {
	agent: string | null;
	astGrep: string | null;
}

function imageLabel(value: string | undefined): string | null {
	const label = value?.trim();
	return label && label !== "<no value>" ? label : null;
}

/** Read the version labels baked into a sandbox image, or null if it is absent. */
export async function getImageVersions(imageName: string, commandRunner: CommandRunner = realCommandRunner): Promise<SandboxImageVersions | null> {
	try {
		const { stdout } = await commandRunner.execFile(
			"docker",
			[
				"inspect",
				"--format",
				"{{index .Config.Labels \"bobbit.pi-agent-version\"}}\t{{index .Config.Labels \"bobbit.ast-grep-version\"}}",
				imageName,
			],
			{ timeout: 5000 },
		);
		const [agent, astGrep] = stdout.toString().trim().split("\t", 2);
		return { agent: imageLabel(agent), astGrep: imageLabel(astGrep) };
	} catch {
		return null;
	}
}

/** Backward-compatible access to only the pi-coding-agent image label. */
export async function getImageAgentVersion(imageName: string, commandRunner: CommandRunner = realCommandRunner): Promise<string | null> {
	return (await getImageVersions(imageName, commandRunner))?.agent ?? null;
}

/** Get the host's installed pi-coding-agent version. */
export function getHostAgentVersion(): string | null {
	try {
		const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const mainPath = fileURLToPath(mainUrl);
		const pkgPath = path.resolve(path.dirname(mainPath), "..", "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		return pkg.version || null;
	} catch {
		return null;
	}
}

/**
 * Ensure the sandbox image has the correct pi-coding-agent version.
 * Rebuilds automatically if the version is stale or missing.
 * Returns true if the image is ready.
 */
export async function ensureImageAgentVersion(imageName: string, dockerContextRoot?: string, commandRunner: CommandRunner = realCommandRunner): Promise<boolean> {
	const hostVersion = getHostAgentVersion();
	const astGrepVersion = getPinnedAstGrepVersion();
	if (!hostVersion || !astGrepVersion) {
		console.warn("[sandbox] Cannot determine the pinned sandbox tool versions, skipping image version check");
		return true;
	}

	const imageVersions = await getImageVersions(imageName, commandRunner);
	if (imageVersions?.agent === hostVersion && imageVersions.astGrep === astGrepVersion) {
		console.log(`[sandbox] Image "${imageName}" has pi-coding-agent@${hostVersion} and ast-grep@${astGrepVersion} (matches host)`);
		return true;
	}

	const reasons = [
		imageVersions?.agent === hostVersion
			? null
			: imageVersions?.agent
				? `image has pi-coding-agent v${imageVersions.agent}, host has v${hostVersion}`
				: `image missing pi-coding-agent version label, host has v${hostVersion}`,
		imageVersions?.astGrep === astGrepVersion
			? null
			: imageVersions?.astGrep
				? `image has ast-grep v${imageVersions.astGrep}, host has v${astGrepVersion}`
				: `image missing ast-grep version label, host has v${astGrepVersion}`,
	].filter((reason): reason is string => reason !== null);
	console.log(`[sandbox] Rebuilding image "${imageName}": ${reasons.join("; ")}`);

	const contextRoot = resolveSandboxDockerContext(dockerContextRoot);
	if (!contextRoot) {
		console.error(`[sandbox] Failed to rebuild image "${imageName}": Dockerfile not found at docker/Dockerfile`);
		return false;
	}

	_building = true;
	try {
		await commandRunner.execFile(
			"docker",
			[
				"build",
				"--build-arg",
				`PI_AGENT_VERSION=${hostVersion}`,
				"--build-arg",
				`AST_GREP_VERSION=${astGrepVersion}`,
				"-t",
				imageName,
				path.join(contextRoot, "docker"),
			],
			{ cwd: contextRoot, timeout: 300_000 },
		);
		console.log(`[sandbox] Image "${imageName}" rebuilt with pi-coding-agent@${hostVersion} and ast-grep@${astGrepVersion}`);
		return true;
	} catch (err: any) {
		const errorMsg = err.stderr || err.message || String(err);
		console.error(`[sandbox] Failed to rebuild image "${imageName}": ${errorMsg}`);
		return false;
	} finally {
		_building = false;
	}
}

export async function checkDockerAvailability(imageName?: string, dockerContextRoot?: string, commandRunner: CommandRunner = realCommandRunner): Promise<SandboxStatus> {
	try {
		const { stdout } = await commandRunner.execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
		const status: SandboxStatus = { available: true, dockerVersion: stdout.toString().trim() };
		if (imageName) {
			try {
				await commandRunner.execFile("docker", ["image", "inspect", imageName], { timeout: 5000 });
				status.imageExists = true;
			} catch {
				status.imageExists = false;
			}
			const contextRoot = resolveSandboxDockerContext(dockerContextRoot);
			if (contextRoot) {
				status.dockerfileExists = true;
				status.buildCommand = `docker build -t ${imageName} ${path.join(contextRoot, "docker")}`;
			}
		}
		return status;
	} catch (err) {
		return { available: false, error: String(err) };
	}
}
