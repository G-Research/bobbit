import http from "node:http";
import net from "node:net";

/**
 * Lightweight HTTP/HTTPS forward proxy with hostname allowlist.
 * Used to restrict network access from Docker sandboxed agent containers.
 *
 * - HTTPS tunneling via HTTP CONNECT method
 * - Plain HTTP proxying for non-TLS requests
 * - Only allows requests to hostnames in the allowlist (case-insensitive)
 * - Returns 403 for blocked hosts
 */
export class SandboxProxy {
	private server: http.Server | null = null;
	private _allowlist: string[];
	private _port = 0;

	private _allowlistSet: Set<string>;

	constructor(allowlist: string[]) {
		this._allowlist = allowlist;
		this._allowlistSet = new Set(allowlist.map((h) => h.toLowerCase()));
	}

	get port(): number {
		return this._port;
	}

	get allowlist(): string[] {
		return this._allowlist;
	}

	private isAllowed(hostname: string): boolean {
		return this._allowlistSet.has(hostname.toLowerCase());
	}

	async start(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				this.handleRequest(req, res);
			});

			server.on("connect", (req, clientSocket: net.Socket, head) => {
				this.handleConnect(req, clientSocket, head);
			});

			server.on("error", (err) => {
				console.error("[sandbox-proxy] Server error:", err);
				reject(err);
			});

			server.listen(0, "0.0.0.0", () => {
				const addr = server.address();
				if (addr && typeof addr === "object") {
					this._port = addr.port;
					console.log(`[sandbox-proxy] Listening on 0.0.0.0:${this._port} (allowlist: ${this._allowlist.join(", ") || "none"})`);
					resolve(this._port);
				} else {
					reject(new Error("Failed to get server address"));
				}
			});

			this.server = server;
		});
	}

	stop(): void {
		if (this.server) {
			this.server.close();
			this.server = null;
			this._port = 0;
			console.log("[sandbox-proxy] Stopped");
		}
	}

	/**
	 * Handle HTTP CONNECT method (HTTPS tunneling).
	 * The client sends CONNECT hostname:port, and we create a TCP tunnel if allowed.
	 */
	private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
		const target = req.url || "";
		const colonIdx = target.lastIndexOf(":");
		const hostname = colonIdx > 0 ? target.substring(0, colonIdx) : target;
		const port = colonIdx > 0 ? parseInt(target.substring(colonIdx + 1), 10) : 443;

		if (!this.isAllowed(hostname)) {
			console.log(`[sandbox-proxy] BLOCKED CONNECT ${target}`);
			clientSocket.write(
				"HTTP/1.1 403 Forbidden\r\n" +
				"Content-Type: text/plain\r\n" +
				"\r\n" +
				`Blocked by sandbox proxy: ${hostname} is not in the network allowlist\r\n`,
			);
			clientSocket.end();
			return;
		}

		console.log(`[sandbox-proxy] CONNECT ${target}`);

		const serverSocket = net.connect(port, hostname, () => {
			clientSocket.write(
				"HTTP/1.1 200 Connection Established\r\n" +
				"\r\n",
			);
			if (head.length > 0) {
				serverSocket.write(head);
			}
			serverSocket.pipe(clientSocket);
			clientSocket.pipe(serverSocket);
		});

		serverSocket.on("error", (err) => {
			console.error(`[sandbox-proxy] CONNECT error to ${target}:`, err.message);
			clientSocket.write(
				"HTTP/1.1 502 Bad Gateway\r\n" +
				"Content-Type: text/plain\r\n" +
				"\r\n" +
				`Proxy connection error: ${err.message}\r\n`,
			);
			clientSocket.end();
		});

		clientSocket.on("error", (err) => {
			console.error(`[sandbox-proxy] Client socket error for ${target}:`, err.message);
			serverSocket.destroy();
		});
	}

	/**
	 * Handle plain HTTP requests (non-CONNECT).
	 * Parse the target hostname from the request URL and proxy if allowed.
	 */
	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const reqUrl = req.url || "";
		let hostname: string;
		let port: number;
		let path: string;

		try {
			const parsed = new URL(reqUrl);
			hostname = parsed.hostname;
			port = parsed.port ? parseInt(parsed.port, 10) : 80;
			path = parsed.pathname + parsed.search;
		} catch {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Bad request: invalid URL");
			return;
		}

		if (!this.isAllowed(hostname)) {
			console.log(`[sandbox-proxy] BLOCKED ${req.method} ${reqUrl}`);
			res.writeHead(403, { "Content-Type": "text/plain" });
			res.end(`Blocked by sandbox proxy: ${hostname} is not in the network allowlist`);
			return;
		}

		console.log(`[sandbox-proxy] ${req.method} ${reqUrl}`);

		const proxyReq = http.request(
			{
				hostname,
				port,
				path,
				method: req.method,
				headers: req.headers,
			},
			(proxyRes) => {
				res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
				proxyRes.pipe(res);
			},
		);

		proxyReq.on("error", (err) => {
			console.error(`[sandbox-proxy] Proxy request error for ${reqUrl}:`, err.message);
			if (!res.headersSent) {
				res.writeHead(502, { "Content-Type": "text/plain" });
			}
			res.end(`Proxy error: ${err.message}`);
		});

		req.pipe(proxyReq);
	}
}
