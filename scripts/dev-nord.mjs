#!/usr/bin/env node
/**
 * Launch dev:harness in NordLynx mesh mode.
 *
 * 1. Detects the NordLynx mesh IP
 * 2. Ensures a TLS cert exists (so Vite can serve HTTPS immediately)
 * 3. Sets BOBBIT_NORD=1 so Vite binds to the mesh IP with TLS
 * 4. Passes --nord to the harness so the server does the same
 */
import { execSync } from "node:child_process";
import os from "node:os";

// Detect NordLynx IP (same logic as cli.ts)
function findNordLynxIp() {
	const interfaces = os.networkInterfaces();
	for (const [name, addrs] of Object.entries(interfaces)) {
		if (!addrs) continue;
		if (!name.toLowerCase().includes("nordlynx")) continue;
		for (const addr of addrs) {
			if (addr.family === "IPv4" && !addr.internal) return addr.address;
		}
	}
	return null;
}

const meshIp = findNordLynxIp();
if (!meshIp) {
	console.error("No NordLynx interface found. Is NordVPN meshnet active?");
	process.exit(1);
}

// Pre-generate the TLS cert so Vite can read it at startup (avoids race).
// The server will reuse it if it already covers the right host.
console.log(`[dev-nord] Mesh IP: ${meshIp}`);
console.log("[dev-nord] Ensuring TLS cert exists...");
execSync(`node -e "
	import('./dist/server/bobbit-dir.js').then(({ setProjectRoot }) => {
		setProjectRoot(process.cwd());
		return import('./dist/server/auth/tls.js');
	}).then(({ ensureTlsCert }) => {
		return import('./dist/server/auth/desec.js').then(({ loadDesecConfig }) => {
			const desec = loadDesecConfig();
			const extraDomains = desec ? [desec.domain] : [];
			return ensureTlsCert('${meshIp}', extraDomains);
		});
	}).then(r => console.log('[dev-nord] Cert ready:', r.cert));
"`, { stdio: "inherit" });

execSync(
	'npx concurrently -n harness,ui -c yellow,green "node dist/server/harness.js -- --cwd . --no-ui --nord" "vite"',
	{ stdio: "inherit", env: { ...process.env, BOBBIT_NORD: "1" } },
);
