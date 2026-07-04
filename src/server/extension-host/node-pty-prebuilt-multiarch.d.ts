declare module "@homebridge/node-pty-prebuilt-multiarch" {
	export type IPty = {
		readonly pid: number;
		write(data: string): void;
		resize(cols: number, rows: number): void;
		kill(signal?: string): void;
		onData?: (cb: (data: string) => void) => { dispose(): void };
		onExit?: (cb: (event: { exitCode: number; signal?: number }) => void) => { dispose(): void };
		on?: ((event: "data", cb: (data: string) => void) => void) & ((event: "exit", cb: (code: number, signal?: number) => void) => void);
	};

	export function spawn(file: string, args: string[] | string, opts: Record<string, unknown>): IPty;
}
