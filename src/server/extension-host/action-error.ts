/** An error carrying the HTTP status an extension endpoint should surface. */
export class ActionError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ActionError";
		this.status = status;
	}
}
