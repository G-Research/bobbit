import { existsSync } from "node:fs";
import http, { type Server } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Activated by the concurrently developed foundation branch after local merge.
const BASE_PATH_IMPLEMENTED = existsSync(join(REPO_ROOT, "src", "shared", "base-path.ts"));

interface WatchdogProbeTarget {
	protocol: "http:" | "https:";
	hostname: string;
	port: number;
	basePath: string;
}

interface WatchdogModule {
	resolveWatchdogProbeTarget?: (...args: any[]) => WatchdogProbeTarget;
	watchdogHealthPath?: (target: WatchdogProbeTarget) => string;
}

function listen(server: Server): Promise<number> {
	return new Promise((resolvePort, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolvePort((server.address() as import("node:net").AddressInfo).port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolveClose, reject) => {
		server.close((error) => error ? reject(error) : resolveClose());
	});
}

function probe(target: WatchdogProbeTarget, path: string): Promise<number> {
	return new Promise((resolveStatus, reject) => {
		const request = http.request({
			hostname: target.hostname,
			port: target.port,
			path,
			method: "GET",
		}, (response) => {
			response.resume();
			response.once("end", () => resolveStatus(response.statusCode ?? 0));
		});
		request.once("error", reject);
		request.end();
	});
}

describe.skipIf(!BASE_PATH_IMPLEMENTED).sequential("watchdog mounted health target integration", () => {
	let server: Server;
	let port: number;
	let paths: string[];
	let watchdog: WatchdogModule;

	beforeAll(async () => {
		paths = [];
		server = http.createServer((request, response) => {
			paths.push(request.url ?? "");
			if (request.url === "/team/bobbit/api/health") {
				response.writeHead(204);
				response.end();
				return;
			}
			response.writeHead(404);
			response.end();
		});
		port = await listen(server);
		watchdog = await import("../../src/server/watchdog.js") as WatchdogModule;
	});

	afterAll(async () => {
		await close(server);
	});

	it("exports the generation-target resolver and probes the nested mount rather than a healthy server's root", async () => {
		expect(typeof watchdog.resolveWatchdogProbeTarget).toBe("function");
		expect(typeof watchdog.watchdogHealthPath).toBe("function");
		const target: WatchdogProbeTarget = {
			protocol: "http:",
			hostname: "127.0.0.1",
			port,
			basePath: "/team/bobbit",
		};
		const mountedPath = watchdog.watchdogHealthPath!(target);
		expect(mountedPath).toBe("/team/bobbit/api/health");
		expect(await probe(target, mountedPath)).toBe(204);
		expect(await probe(target, "/api/health")).toBe(404);
		expect(paths).toEqual(["/team/bobbit/api/health", "/api/health"]);
	});

	it("keeps the root watchdog health path backward compatible", () => {
		expect(watchdog.watchdogHealthPath!({
			protocol: "https:",
			hostname: "localhost",
			port: 3001,
			basePath: "",
		})).toBe("/api/health");
	});
});
