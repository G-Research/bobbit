import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SandboxStatus {
	available: boolean;
	error?: string;
	dockerVersion?: string;
	imageExists?: boolean;
	pool?: { total: number; idle: number; claimed: number; warming: number };
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
			}
		}
		return status;
	} catch (err) {
		return { available: false, error: String(err) };
	}
}
