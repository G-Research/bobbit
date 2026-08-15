import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";

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

/**
 * Image label for the Bobbit-owned global runtime import contract. Bump the
 * fixed schema version only when the sandbox dispatcher runtime changes; it
 * intentionally carries no provider or dependency-version data.
 */
export const SANDBOX_RUNTIME_SCHEMA_LABEL = "bobbit.runtime-schema";
export const SANDBOX_RUNTIME_SCHEMA_VERSION = "2";

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
		await commandRunner.execFile("docker", ["build", "-t", imageName, path.join(contextRoot, "docker")], { cwd: contextRoot, timeout: 300_000 });
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

async function getImageLabel(imageName: string, label: string, commandRunner: CommandRunner): Promise<string | null> {
	try {
		const { stdout } = await commandRunner.execFile(
			"docker", ["inspect", "--format", `{{index .Config.Labels ${JSON.stringify(label)}}}`, imageName],
			{ timeout: 5000 },
		);
		const value = stdout.toString().trim();
		return value && value !== "<no value>" ? value : null;
	} catch {
		return null;
	}
}

/** Check the image's baked-in pi-coding-agent version. */
export async function getImageAgentVersion(imageName: string, commandRunner: CommandRunner = realCommandRunner): Promise<string | null> {
	return getImageLabel(imageName, "bobbit.pi-agent-version", commandRunner);
}

/** Check the image's Bobbit-owned dispatcher runtime schema. */
export async function getImageRuntimeSchemaVersion(imageName: string, commandRunner: CommandRunner = realCommandRunner): Promise<string | null> {
	return getImageLabel(imageName, SANDBOX_RUNTIME_SCHEMA_LABEL, commandRunner);
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
 * Ensure the sandbox image has the correct pi-coding-agent version and
 * Bobbit-owned dispatcher runtime schema. Rebuilds when either is stale or
 * missing, so a previously matching Pi image cannot run an incompatible worker.
 */
export async function ensureImageAgentVersion(imageName: string, dockerContextRoot?: string, commandRunner: CommandRunner = realCommandRunner): Promise<boolean> {
	const hostVersion = getHostAgentVersion();
	if (!hostVersion) {
		console.warn("[sandbox] Cannot determine host pi-coding-agent version, skipping image version check");
		return true;
	}

	const [imageVersion, runtimeSchemaVersion] = await Promise.all([
		getImageAgentVersion(imageName, commandRunner),
		getImageRuntimeSchemaVersion(imageName, commandRunner),
	]);
	if (imageVersion === hostVersion && runtimeSchemaVersion === SANDBOX_RUNTIME_SCHEMA_VERSION) {
		console.log(`[sandbox] Image "${imageName}" has pi-coding-agent@${imageVersion} and current Bobbit runtime schema`);
		return true;
	}

	const reasons: string[] = [];
	if (imageVersion !== hostVersion) {
		reasons.push(imageVersion
			? `image has pi-coding-agent@${imageVersion}, host has @${hostVersion}`
			: `image missing pi-coding-agent version label, host has @${hostVersion}`);
	}
	if (runtimeSchemaVersion !== SANDBOX_RUNTIME_SCHEMA_VERSION) {
		reasons.push(runtimeSchemaVersion
			? `image has runtime schema ${runtimeSchemaVersion}, expected ${SANDBOX_RUNTIME_SCHEMA_VERSION}`
			: `image missing ${SANDBOX_RUNTIME_SCHEMA_LABEL} label`);
	}
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
			["build", "--build-arg", `PI_AGENT_VERSION=${hostVersion}`, "-t", imageName, path.join(contextRoot, "docker")],
			{ cwd: contextRoot, timeout: 300_000 },
		);
		console.log(`[sandbox] Image "${imageName}" rebuilt with pi-coding-agent@${hostVersion}`);
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
