/**
 * Orders stale-while-revalidate REST projections against completion broadcasts.
 *
 * A request owns its keyed generation until another request begins or an
 * accepted WebSocket completion supersedes it. Callers must check the ticket at
 * the point where a REST result would mutate client state.
 */
export interface RemoteStateRequestTicket {
	readonly key: string;
	readonly generation: number;
}

export type RemoteStateClientSurface = "dashboard" | "session" | "sidebar";
export type RemoteStateClientResource = "git" | "pr";

export function remoteStateRequestKey(
	surface: RemoteStateClientSurface,
	ownerId: string,
	resource: RemoteStateClientResource,
): string {
	return `${surface}\u0000${ownerId}\u0000${resource}`;
}

export class RemoteStateRequestOrder {
	private readonly generations = new Map<string, number>();

	begin(key: string): RemoteStateRequestTicket {
		const generation = this.advance(key);
		return { key, generation };
	}

	supersede(key: string): void {
		this.advance(key);
	}

	isCurrent(ticket: RemoteStateRequestTicket): boolean {
		return this.generations.get(ticket.key) === ticket.generation;
	}

	private advance(key: string): number {
		const generation = (this.generations.get(key) ?? 0) + 1;
		this.generations.set(key, generation);
		return generation;
	}
}

export const remoteStateRequestOrder = new RemoteStateRequestOrder();
