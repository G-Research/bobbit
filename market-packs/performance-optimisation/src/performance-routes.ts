import { PerformanceDatabaseError, openPerformanceDatabase } from "./performance-database.ts";

interface PerformanceRouteContext {
	host?: {
		localData?: { directory(): string | Promise<string> };
	};
}

export type PerformanceSnapshotRouteResult =
	| Record<string, unknown>
	| { ok: false; error: { code: string; message: string; retryable: boolean } };

function safeRouteError(error: unknown): PerformanceSnapshotRouteResult {
	if (error instanceof PerformanceDatabaseError) {
		return {
			ok: false,
			error: {
				code: error.code,
				message: error.code === "CORRUPT_DATABASE"
					? "The performance registry is corrupt and was not replaced. Restore or repair performance.sqlite."
					: error.code === "NEWER_SCHEMA"
						? "The performance registry was created by a newer pack version."
						: error.message,
				retryable: error.code === "OPEN_FAILED",
			},
		};
	}
	return { ok: false, error: { code: "PERFORMANCE_SNAPSHOT_FAILED", message: "The performance snapshot is unavailable.", retryable: true } };
}

export function createPerformanceRoutes(options: { nativeBinding?: string } = {}) {
	return {
		"performance-snapshot": async (ctx: PerformanceRouteContext): Promise<PerformanceSnapshotRouteResult> => {
			try {
				if (!ctx?.host?.localData) throw new PerformanceDatabaseError("INVALID_BINDING", "performance local-data capability is unavailable");
				const directory = await ctx.host.localData.directory();
				const db = openPerformanceDatabase(directory, { nativeBinding: options.nativeBinding });
				try { return db.snapshot(); }
				finally { db.close(); }
			} catch (error) {
				return safeRouteError(error);
			}
		},
	};
}

export const routes = createPerformanceRoutes();
