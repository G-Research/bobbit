import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

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
		await execFileAsync("docker", ["build", "-t", imageName, "docker/"], { cwd: projectDir, timeout: 120_000 });
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
