/**
 * deSEC dynDNS integration.
 * Updates the domain's A record to point to the current host IP on startup.
 * Config stored in .bobbit/state/desec.json
 */

import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const STATE_DIR = bobbitStateDir();
const CONFIG_PATH = path.join(STATE_DIR, "desec.json");

export interface DesecConfig {
	domain: string;
	token: string;
}

/** Load deSEC config from disk, or null if not configured. */
export function loadDesecConfig(): DesecConfig | null {
	if (!fs.existsSync(CONFIG_PATH)) return null;
	try {
		return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
	} catch {
		return null;
	}
}

/** Save deSEC config to disk. */
export function saveDesecConfig(config: DesecConfig): void {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Update the deSEC domain's A record to point to the given IP.
 * Called on server startup to keep dynDNS fresh.
 * Fails silently — cert/DNS issues shouldn't prevent server from starting.
 */
export async function updateDesecIp(config: DesecConfig, ip: string, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
	try {
		const res = await fetchImpl(`https://update.dedyn.io/?myipv4=${ip}`, {
			headers: {
				"Authorization": `Basic ${Buffer.from(`${config.domain}:${config.token}`).toString("base64")}`,
			},
		});
		const body = await res.text();
		if (body.startsWith("good") || body.startsWith("nochg")) {
			console.log(`  deSEC dynDNS: ${config.domain} → ${ip} (${body.trim()})`);
		} else {
			console.log(`  deSEC dynDNS update warning: ${body.trim()}`);
		}
	} catch (err: any) {
		console.log(`  deSEC dynDNS update failed: ${err.message}`);
	}
}
