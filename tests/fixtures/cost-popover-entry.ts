import { html, render } from "lit";
import "../../src/ui/components/CostPopover.js";

interface FixtureResponse {
	aggregate?: any;
	session?: any;
	sessions?: any[];
	delegates?: any[];
	ok?: boolean;
	status?: number;
}

const calls: string[] = [];
let response: FixtureResponse = {};

(window as any).__setCostPopoverResponse = (next: FixtureResponse) => {
	response = next;
	calls.length = 0;
};

(window as any).__getCostPopoverCalls = () => [...calls];

window.fetch = async (url: any) => {
	calls.push(String(url));
	const ok = response.ok !== false;
	return {
		ok,
		status: response.status ?? (ok ? 200 : 500),
		async json() {
			if (String(url).includes("/api/goals/")) {
				return {
					aggregate: response.aggregate,
					sessions: response.sessions || [],
				};
			}
			return {
				session: response.session ?? response.aggregate,
				delegates: response.delegates || [],
			};
		},
	} as Response;
};

(window as any).__mountCostPopover = (kind: "goal" | "session", data: FixtureResponse) => {
	(window as any).__setCostPopoverResponse(data);
	const container = document.getElementById("container")!;
	render(html`<cost-popover
		.open=${true}
		.goalId=${kind === "goal" ? "goal-cost" : undefined}
		.sessionId=${kind === "session" ? "session-cost" : undefined}
	></cost-popover>`, container);
};

(window as any).__ready = true;
