export interface SendableWebSocket {
	readyState: number;
	streamBackpressureCutover?: boolean;
}

/**
 * Authoritative egress fence for authenticated WebSocket traffic.
 *
 * Stream backpressure cutover is marked before transport termination. A
 * terminate failure or delayed close can therefore leave `readyState` OPEN;
 * every post-auth physical send boundary must also honor the durable marker.
 */
export function isSocketSendable(socket: SendableWebSocket): boolean {
	return socket.readyState === 1 && socket.streamBackpressureCutover !== true;
}
