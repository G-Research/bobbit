export function scheduleGateStatusRefreshForGoal(goalId: string | null | undefined, delayMs = 50): void {
	void import("./api.js").then(m => m.scheduleGateStatusRefreshForGoal(goalId, delayMs));
}

export function refreshSessions(): Promise<void> {
	return import("./api.js").then(m => m.refreshSessions());
}

export function scheduleSessionListRefreshFromPush(): void {
	void import("./api.js").then(m => m.scheduleSessionListRefreshFromPush());
}

export function scheduleStaffListRefreshFromPush(): void {
	void import("./api.js").then(m => m.scheduleStaffListRefreshFromPush());
}
