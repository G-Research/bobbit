/**
 * Obtain a Let's Encrypt certificate for a deSEC-hosted domain.
 * Uses ACME DNS-01 challenge via the deSEC API.
 *
 * Usage: npx tsx scripts/get-cert.ts <domain> <desec-token>
 * Example: npx tsx scripts/get-cert.ts yourname.dedyn.io YOUR_DESEC_TOKEN
 *
 * Outputs cert and key to ~/.pi/gateway-cert.pem and ~/.pi/gateway-key.pem
 */

import * as acme from "acme-client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI_DIR = path.join(os.homedir(), ".pi");
const CERT_PATH = path.join(PI_DIR, "gateway-cert.pem");
const KEY_PATH = path.join(PI_DIR, "gateway-key.pem");
const ACME_ACCOUNT_KEY_PATH = path.join(PI_DIR, "acme-account-key.pem");

const DESEC_API = "https://desec.io/api/v1";

async function desecRequest(endpoint: string, token: string, options: RequestInit = {}) {
	const res = await fetch(`${DESEC_API}${endpoint}`, {
		...options,
		headers: {
			"Authorization": `Token ${token}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
	if (!res.ok && res.status !== 404) {
		const body = await res.text();
		throw new Error(`deSEC API error ${res.status}: ${body}`);
	}
	return res;
}

async function setTxtRecord(domain: string, token: string, value: string) {
	const subname = "_acme-challenge";

	// Try to create or update the TXT record
	const res = await desecRequest(`/domains/${domain}/rrsets/`, token, {
		method: "POST",
		body: JSON.stringify({
			subname,
			type: "TXT",
			ttl: 3600,
			records: [`"${value}"`],
		}),
	});

	if (res.status === 409) {
		// Record already exists, update it
		await desecRequest(`/domains/${domain}/rrsets/${subname}/TXT/`, token, {
			method: "PUT",
			body: JSON.stringify({
				ttl: 3600,
				records: [`"${value}"`],
			}),
		});
	}
}

async function deleteTxtRecord(domain: string, token: string) {
	await desecRequest(`/domains/${domain}/rrsets/_acme-challenge/TXT/`, token, {
		method: "DELETE",
	});
}

async function waitForDnsPropagation(domain: string, expectedValue: string, maxWait = 120) {
	const start = Date.now();
	console.log(`  Waiting for DNS propagation (up to ${maxWait}s)...`);

	while ((Date.now() - start) / 1000 < maxWait) {
		try {
			// Query deSEC's own nameserver for faster detection
			const res = await fetch(`https://desec.io/api/v1/domains/${domain}/rrsets/_acme-challenge/TXT/`, {
				headers: { "Accept": "application/json" },
			});
			if (res.ok) {
				const data = await res.json() as { records: string[] };
				if (data.records?.some((r: string) => r.includes(expectedValue))) {
					console.log(`  DNS record propagated.`);
					return;
				}
			}
		} catch {}
		await new Promise(r => setTimeout(r, 5000));
	}
	// Proceed anyway — Let's Encrypt will tell us if it's not ready
	console.log(`  Proceeding after ${maxWait}s wait...`);
}

async function main() {
	const [domain, desecToken] = process.argv.slice(2);
	if (!domain || !desecToken) {
		console.error("Usage: npx tsx scripts/get-cert.ts <domain> <desec-token>");
		process.exit(1);
	}

	fs.mkdirSync(PI_DIR, { recursive: true });

	console.log(`Obtaining Let's Encrypt certificate for ${domain}...`);

	// Load or generate ACME account key
	let accountKey: string;
	if (fs.existsSync(ACME_ACCOUNT_KEY_PATH)) {
		accountKey = fs.readFileSync(ACME_ACCOUNT_KEY_PATH, "utf-8");
		console.log("  Using existing ACME account key.");
	} else {
		console.log("  Generating new ACME account key...");
		accountKey = (await acme.crypto.createPrivateRsaKey()).toString();
		fs.writeFileSync(ACME_ACCOUNT_KEY_PATH, accountKey);
	}

	// Create ACME client (production)
	const client = new acme.Client({
		directoryUrl: acme.directory.letsencrypt.production,
		accountKey,
	});

	// Register account (idempotent)
	await client.createAccount({
		termsOfServiceAgreed: true,
	});
	console.log("  ACME account ready.");

	// Create certificate order
	const order = await client.createOrder({
		identifiers: [{ type: "dns", value: domain }],
	});

	// Get authorization and challenge
	const authorizations = await client.getAuthorizations(order);
	const auth = authorizations[0];
	const challenge = auth.challenges.find((c: { type: string }) => c.type === "dns-01");
	if (!challenge) throw new Error("No DNS-01 challenge found");

	const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
	console.log(`  Setting DNS TXT record for _acme-challenge.${domain}...`);
	await setTxtRecord(domain, desecToken, keyAuthorization);

	// Wait for DNS to propagate
	await waitForDnsPropagation(domain, keyAuthorization);

	// Additional wait for external DNS propagation
	console.log("  Waiting 30s for external DNS propagation...");
	await new Promise(r => setTimeout(r, 30000));

	// Complete the challenge
	console.log("  Completing ACME challenge...");
	await client.completeChallenge(challenge);
	await client.waitForValidStatus(challenge);
	console.log("  Challenge validated!");

	// Generate CSR and finalize order
	const [csrKey, csr] = await acme.crypto.createCsr({
		commonName: domain,
	});
	await client.finalizeOrder(order, csr);
	const cert = await client.getCertificate(order);

	// Write cert and key
	fs.writeFileSync(CERT_PATH, cert);
	fs.writeFileSync(KEY_PATH, csrKey.toString());
	if (process.platform !== "win32") {
		fs.chmodSync(KEY_PATH, 0o600);
	}

	// Clean up the TXT record
	try {
		await deleteTxtRecord(domain, desecToken);
	} catch {}

	// Save deSEC config for dynDNS updates on server startup
	const desecConfigPath = path.join(PI_DIR, "desec.json");
	fs.writeFileSync(desecConfigPath, JSON.stringify({ domain, token: desecToken }, null, 2));

	console.log(`\nSuccess!`);
	console.log(`  Certificate: ${CERT_PATH}`);
	console.log(`  Private key: ${KEY_PATH}`);
	console.log(`  deSEC config: ${desecConfigPath}`);
	console.log(`\nRestart Bobbit to use the new certificate.`);
	console.log(`Access via: https://${domain}:5173 (dev) or https://${domain}:3001 (production)`);
}

main().catch((err) => {
	console.error("Error:", err.message || err);
	process.exit(1);
});
