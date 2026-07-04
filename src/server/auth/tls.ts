import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { serverSecretsDir } from "../bobbit-dir.js";

// TLS material is a live server secret, so it lives under serverSecretsDir()
// (outside any project root). Resolved lazily at call time because the secrets
// dir depends on env (BOBBIT_SECRETS_DIR) that must be readable when used, not
// at module load.
function tlsDir(): string { return path.join(serverSecretsDir(), "tls"); }
function certPath(): string { return path.join(tlsDir(), "cert.pem"); }
function keyPath(): string { return path.join(tlsDir(), "key.pem"); }
// mkcert CA files
function caCertPath(): string { return path.join(tlsDir(), "ca.crt"); }
function caKeyPath(): string { return path.join(tlsDir(), "ca.key"); }

/** Resolve the openssl binary, checking Git-bundled locations on Windows. */
function resolveOpenssl(): string {
	if (process.platform !== "win32") return "openssl";

	// Check if openssl is already on PATH
	try {
		execSync("openssl version", { stdio: "pipe", shell: true as unknown as string });
		return "openssl";
	} catch {}

	// Common Git for Windows bundled locations
	const candidates = [
		path.join("C:", "Program Files", "Git", "usr", "bin", "openssl.exe"),
		path.join("C:", "Program Files", "Git", "mingw64", "bin", "openssl.exe"),
		path.join("C:", "Program Files (x86)", "Git", "usr", "bin", "openssl.exe"),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return `"${p}"`;
	}

	return "openssl"; // fall through — will produce the original error
}

export interface TlsFiles {
	cert: string;
	key: string;
	/** Path to CA certificate, if generated via mkcert. Users install this to trust the cert. */
	caCert?: string;
}

/**
 * Ensure a TLS certificate exists for the given host IP.
 *
 * Strategy:
 *   1. Try mkcert (npm package) — generates a local CA + cert trusted by browsers
 *      once the CA cert is installed on the device.
 *   2. Fall back to openssl self-signed cert (existing behavior).
 *
 * Returns paths to the cert, key, and optionally the CA cert.
 */
export async function ensureTlsCert(host: string, extraDomains?: string[]): Promise<TlsFiles> {
	fs.mkdirSync(tlsDir(), { recursive: true });

	// All domains/IPs the cert should cover
	const allDomains = [host, "127.0.0.1", "localhost", ...(extraDomains || [])];

	// If existing cert covers all required names, reuse it
	if (fs.existsSync(certPath()) && fs.existsSync(keyPath())) {
		if (certCoversAllDomains(certPath(), allDomains)) {
			const caCert = fs.existsSync(caCertPath()) ? caCertPath() : undefined;
			return { cert: certPath(), key: keyPath(), caCert };
		}
		console.log(`  TLS cert does not cover all required names, regenerating...`);
	}

	// Try mkcert first, fall back to openssl
	try {
		return await generateMkcertCert(host, allDomains);
	} catch (err: any) {
		console.log(`  mkcert unavailable (${err.message}), falling back to openssl self-signed cert`);
		return generateSelfSignedCert(host, allDomains);
	}
}

/**
 * Generate a CA + cert using the mkcert npm package.
 * The CA cert can be installed on devices to trust all Bobbit certs.
 */
async function generateMkcertCert(_host: string, allDomains: string[]): Promise<TlsFiles> {
	// Dynamic import — fails fast if mkcert isn't installed
	const { createCA, createCert } = await import("mkcert");

	// Reuse existing CA if available, otherwise create one
	let caCert: string;
	let caKey: string;

	if (fs.existsSync(caCertPath()) && fs.existsSync(caKeyPath())) {
		console.log(`  Reusing existing Bobbit CA from ${tlsDir()}`);
		caCert = fs.readFileSync(caCertPath(), "utf-8");
		caKey = fs.readFileSync(caKeyPath(), "utf-8");
	} else {
		console.log(`  Creating Bobbit local CA...`);
		const ca = await createCA({
			organization: "Bobbit Local CA",
			countryCode: "US",
			state: "Local",
			locality: "Local",
			validity: 3650,
		});
		caCert = ca.cert;
		caKey = ca.key;
		fs.writeFileSync(caCertPath(), caCert);
		fs.writeFileSync(caKeyPath(), caKey);
		if (process.platform !== "win32") {
			fs.chmodSync(caKeyPath(), 0o600);
		}
		console.log(`  CA cert: ${caCertPath()}`);
	}

	// Generate a cert for all required domains signed by our CA
	console.log(`  Generating mkcert TLS certificate for: ${allDomains.join(", ")}`);
	// iOS/Safari rejects leaf certs with validity > 825 days (CERT_VALIDITY_TOO_LONG).
	// Keep the CA long-lived (3650d) but the leaf short (397d, under the 398 public-CA limit too).
	const cert = await createCert({
		ca: { cert: caCert, key: caKey },
		domains: allDomains,
		validity: 397,
	});

	fs.writeFileSync(certPath(), cert.cert);
	fs.writeFileSync(keyPath(), cert.key);
	if (process.platform !== "win32") {
		fs.chmodSync(keyPath(), 0o600);
		fs.chmodSync(certPath(), 0o644);
	}

	console.log(`  TLS cert: ${certPath()} (signed by Bobbit CA)`);
	console.log(`  TLS key:  ${keyPath()}`);
	console.log(`  Install ${caCertPath()} on other devices to trust this certificate.`);

	return { cert: certPath(), key: keyPath(), caCert: caCertPath() };
}

function generateSelfSignedCert(_host: string, allDomains: string[]): TlsFiles {
	console.log(`  Generating self-signed TLS certificate for: ${allDomains.join(", ")}`);

	const openssl = resolveOpenssl();

	// Build SAN from all domains — classify each as IP or DNS
	const sanParts = allDomains.map(d => /^\d+\.\d+\.\d+\.\d+$/.test(d) ? `IP:${d}` : `DNS:${d}`);
	const san = `subjectAltName=${sanParts.join(",")}`;

	try {
		execSync(
			[
				openssl, "req",
				"-x509",
				"-newkey", "ec",
				"-pkeyopt", "ec_paramgen_curve:prime256v1",
				"-nodes",
				"-days", "397",
				"-subj", `"/CN=bobbit"`,
				"-addext", `"${san}"`,
				"-keyout", `"${keyPath()}"`,
				"-out", `"${certPath()}"`,
			].join(" "),
			{ stdio: "pipe", shell: true as unknown as string },
		);
	} catch (err: any) {
		// Try alternate openssl syntax for older versions that don't support -addext
		try {
			// Write a minimal openssl config with SAN
			const cnfPath = path.join(tlsDir(), "openssl.cnf");
			fs.writeFileSync(cnfPath, [
				"[req]",
				"distinguished_name = req_dn",
				"x509_extensions = v3_ext",
				"prompt = no",
				"",
				"[req_dn]",
				"CN = bobbit",
				"",
				"[v3_ext]",
				`subjectAltName = ${sanParts.join(",")}`,
			].join("\n"));

			execSync(
				[
					openssl, "req",
					"-x509",
					"-newkey", "ec",
					"-pkeyopt", "ec_paramgen_curve:prime256v1",
					"-nodes",
					"-days", "397",
					"-config", `"${cnfPath}"`,
					"-keyout", `"${keyPath()}"`,
					"-out", `"${certPath()}"`,
				].join(" "),
				{ stdio: "pipe", shell: true as unknown as string },
			);
			fs.unlinkSync(cnfPath);
		} catch (err2: any) {
			throw new Error(
				`Failed to generate TLS certificate. Is openssl installed?\n` +
				`  ${err2.stderr?.toString() || err2.message}`,
			);
		}
	}

	// Restrict key permissions (owner-only on Unix)
	if (process.platform !== "win32") {
		fs.chmodSync(keyPath(), 0o600);
		fs.chmodSync(certPath(), 0o644);
	}

	console.log(`  TLS cert: ${certPath()}`);
	console.log(`  TLS key:  ${keyPath()}`);

	return { cert: certPath(), key: keyPath() };
}

/** Check if an existing cert covers ALL required domains/IPs. */
function certCoversAllDomains(certPath: string, domains: string[]): boolean {
	try {
		const openssl = resolveOpenssl();

		// Check expiry first
		try {
			execSync(
				`${openssl} x509 -in "${certPath}" -noout -checkend 86400`,
				{ stdio: ["pipe", "pipe", "pipe"], shell: true as unknown as string },
			);
		} catch {
			return false; // expired or expiring
		}

		const out = execSync(
			`${openssl} x509 -in "${certPath}" -noout -ext subjectAltName`,
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], shell: true as unknown as string },
		);

		for (const domain of domains) {
			const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(domain);
			const needle = isIp ? `IP Address:${domain}` : `DNS:${domain}`;
			if (!out.includes(needle)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

