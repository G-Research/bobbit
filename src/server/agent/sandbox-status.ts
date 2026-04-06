import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

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

export async function buildSandboxImage(imageName: string, projectDir: string): Promise<{ success: boolean; error?: string }> {
	_building = true;
	try {
		console.log(`[sandbox] Building Docker image "${imageName}" from docker/Dockerfile...`);
		await execFileAsync("docker", ["build", "-t", imageName, "docker/"], { cwd: projectDir, timeout: 300_000 });
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

/**
 * Check if the Docker image has the expected pi-coding-agent version baked in.
 * Returns the image version (or null if not labelled / image missing).
 */
export async function getImageAgentVersion(imageName: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"docker", ["inspect", "--format", "{{index .Config.Labels \"bobbit.pi-agent-version\"}}", imageName],
			{ timeout: 5000 },
		);
		const version = stdout.trim();
		return version && version !== "<no value>" ? version : null;
	} catch {
		return null;
	}
}

/** Get the host's installed pi-coding-agent version. */
export function getHostAgentVersion(): string | null {
	try {
		const mainUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
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
export async function ensureImageAgentVersion(imageName: string, projectDir: string): Promise<boolean> {
	const hostVersion = getHostAgentVersion();
	if (!hostVersion) {
		console.warn("[sandbox] Cannot determine host pi-coding-agent version, skipping image version check");
		return true;
	}

	const imageVersion = await getImageAgentVersion(imageName);
	if (imageVersion === hostVersion) {
		console.log(`[sandbox] Image "${imageName}" has pi-coding-agent@${imageVersion} (matches host)`);
		return true;
	}

	const reason = imageVersion
		? `image has v${imageVersion}, host has v${hostVersion}`
		: `image missing version label, host has v${hostVersion}`;
	console.log(`[sandbox] Rebuilding image "${imageName}": ${reason}`);

	_building = true;
	try {
		await execFileAsync(
			"docker",
			["build", "--build-arg", `PI_AGENT_VERSION=${hostVersion}`, "-t", imageName, "docker/"],
			{ cwd: projectDir, timeout: 180_000 },
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

export async function checkDockerAvailability(imageName?: string): Promise<SandboxStatus> {
	try {
		const { stdout } = await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
		const status: SandboxStatus = { available: true, dockerVersion: stdout.trim() };
		if (imageName) {
			try {
				await execFileAsync("docker", ["image", "inspect", imageName], { timeout: 5000 });
				status.imageExists = true;
			} catch {
				status.imageExists = false;
				// Check if Dockerfile exists so UI can show build instructions
				if (fs.existsSync(path.join(process.cwd(), "docker", "Dockerfile"))) {
					status.dockerfileExists = true;
					status.buildCommand = `docker build -t ${imageName} docker/`;
				}
			}
		}
		return status;
	} catch (err) {
		return { available: false, error: String(err) };
	}
}
