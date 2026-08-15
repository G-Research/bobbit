import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";
import {
	sandboxImageBuildArgs,
	sandboxRequirementsStatus,
	type SandboxImagePlan,
	type SandboxRequirementsStatus,
} from "./sandbox-image-requirements.js";

export interface SandboxStatus {
	available: boolean;
	error?: string;
	dockerVersion?: string;
	/** Exact core-resolved image whose availability was checked. */
	imageName?: string;
	imageExists?: boolean;
	dockerfileExists?: boolean;
	buildCommand?: string;
	requirements?: SandboxRequirementsStatus;
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

/** Build only a core-resolved plan using Bobbit's one fixed Docker context. */
export async function buildSandboxImage(plan: SandboxImagePlan, dockerContextRoot?: string, commandRunner: CommandRunner = realCommandRunner): Promise<{ success: boolean; error?: string }> {
	const contextRoot = resolveSandboxDockerContext(dockerContextRoot);
	if (!contextRoot) {
		const error = "Dockerfile not found at docker/Dockerfile";
		console.error(`[sandbox] Failed to build sandbox image: ${error}`);
		return { success: false, error };
	}

	const hostVersion = getHostAgentVersion();
	const piAgentArgs = hostVersion ? ["--build-arg", `PI_AGENT_VERSION=${hostVersion}`] : [];
	_building = true;
	try {
		console.log(`[sandbox] Building core sandbox image from ${path.join(contextRoot, "docker", "Dockerfile")}...`);
		await commandRunner.execFile(
			"docker",
			["build", ...sandboxImageBuildArgs(plan), ...piAgentArgs, "-t", plan.imageName, path.join(contextRoot, "docker")],
			{ cwd: contextRoot, timeout: 300_000 },
		);
		console.log("[sandbox] Core sandbox image built successfully");
		return { success: true };
	} catch (err: any) {
		const errorMsg = err.stderr || err.message || String(err);
		console.error(`[sandbox] Failed to build sandbox image: ${errorMsg}`);
		return { success: false, error: errorMsg };
	} finally {
		_building = false;
	}
}

/**
 * Check if the Docker image has the expected pi-coding-agent version baked in.
 * Returns the image version (or null if not labelled / image missing).
 */
export async function getImageAgentVersion(imageName: string, commandRunner: CommandRunner = realCommandRunner): Promise<string | null> {
	try {
		const { stdout } = await commandRunner.execFile(
			"docker", ["inspect", "--format", "{{index .Config.Labels \"bobbit.pi-agent-version\"}}", imageName],
			{ timeout: 5000 },
		);
		const version = stdout.toString().trim();
		return version && version !== "<no value>" ? version : null;
	} catch {
		return null;
	}
}

/** Return the core requirements fingerprint baked into an image, if any. */
export async function getImageRequirementsFingerprint(imageName: string, commandRunner: CommandRunner = realCommandRunner): Promise<string | null> {
	try {
		const { stdout } = await commandRunner.execFile(
			"docker", ["inspect", "--format", "{{index .Config.Labels \"bobbit.sandbox-requirements-fingerprint\"}}", imageName],
			{ timeout: 5000 },
		);
		const fingerprint = stdout.toString().trim();
		return fingerprint && fingerprint !== "<no value>" ? fingerprint : null;
	} catch {
		return null;
	}
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
 * Ensure the exact image plan has both the host Pi and plan fingerprint labels.
 * Rebuilds through the same core-owned builder if either label is stale.
 */
export async function ensureImageAgentVersion(plan: SandboxImagePlan, dockerContextRoot?: string, commandRunner: CommandRunner = realCommandRunner): Promise<boolean> {
	const hostVersion = getHostAgentVersion();
	const [imageVersion, imageFingerprint] = await Promise.all([
		getImageAgentVersion(plan.imageName, commandRunner),
		getImageRequirementsFingerprint(plan.imageName, commandRunner),
	]);
	const piMatches = hostVersion === null || imageVersion === hostVersion;
	if (piMatches && imageFingerprint === plan.fingerprint) {
		console.log("[sandbox] Core sandbox image labels match the desired plan");
		return true;
	}

	const reasons = [
		!piMatches && (imageVersion ? `image has v${imageVersion}, host has v${hostVersion}` : "image missing Pi version label"),
		imageFingerprint !== plan.fingerprint && "image requirements fingerprint does not match",
	].filter(Boolean).join("; ");
	console.log(`[sandbox] Rebuilding image: ${reasons}`);
	const result = await buildSandboxImage(plan, dockerContextRoot, commandRunner);
	return result.success;
}

/**
 * Check Docker and, when a plan is supplied, whether the exact labelled image
 * is ready. A present base image is never reported as an available profile plan.
 */
export async function checkDockerAvailability(plan?: SandboxImagePlan, dockerContextRoot?: string, commandRunner: CommandRunner = realCommandRunner): Promise<SandboxStatus> {
	try {
		const { stdout } = await commandRunner.execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
		const status: SandboxStatus = {
			available: true,
			dockerVersion: stdout.toString().trim(),
			...(plan ? { imageName: plan.imageName } : {}),
		};
		if (!plan) return status;

		try {
			await commandRunner.execFile("docker", ["image", "inspect", plan.imageName], { timeout: 5000 });
			status.imageExists = true;
		} catch {
			status.imageExists = false;
		}
		const contextRoot = resolveSandboxDockerContext(dockerContextRoot);
		if (contextRoot) {
			status.dockerfileExists = true;
			status.buildCommand = `docker build -t ${plan.imageName} ${path.join(contextRoot, "docker")}`;
		}
		if (!status.imageExists) {
			status.requirements = sandboxRequirementsStatus(plan, "pending");
			return status;
		}

		const [imageVersion, imageFingerprint] = await Promise.all([
			getImageAgentVersion(plan.imageName, commandRunner),
			getImageRequirementsFingerprint(plan.imageName, commandRunner),
		]);
		const hostVersion = getHostAgentVersion();
		const piMatches = hostVersion === null || imageVersion === hostVersion;
		status.requirements = sandboxRequirementsStatus(plan, piMatches && imageFingerprint === plan.fingerprint ? "available" : "pending");
		return status;
	} catch (err) {
		return {
			available: false,
			error: String(err),
			...(plan ? {
				imageName: plan.imageName,
				requirements: sandboxRequirementsStatus(plan, "unsupported"),
			} : {}),
		};
	}
}
