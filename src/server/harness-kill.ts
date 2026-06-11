/**
 * Pure, side-effect-free helpers for the dev restart harness's process-kill
 * strategy. Importing this module must do NOTHING (no launch/watch code) so it
 * can be unit-tested in isolation.
 *
 * Why this exists: the harness used to force-kill the gateway on Windows with
 * `taskkill /pid <pid> /T /F`. The `/T` walks the gateway's child-process tree
 * by parent→child PID linkage and kills EVERY descendant — including the
 * detached `bash.exe` wrappers running `bash_bg` background commands. On
 * Windows `detached: true` only creates a new process *group*; it does not sever
 * the parent-PID linkage, so `/T` still finds and euthanizes those wrappers, and
 * `/F` denies them the chance to flush their `.status` file. The result: on the
 * next boot the persisted bg record has a dead `processPid` and no status
 * snapshot, so restore correctly classifies it `unrecoverable`.
 *
 * Dropping `/T` force-kills ONLY the gateway process. The detached + unref'd bg
 * wrappers then survive the restart, keep writing their spools while the gateway
 * is down, and write `.status` on natural exit — so restore can re-attach to a
 * still-running process (or read the real exit code of one that finished during
 * downtime). The single-process force-kill still reliably frees the port.
 */

/**
 * Build the Windows gateway-kill argv: force-kill ONLY the given gateway PID,
 * WITHOUT `/T` (no tree-kill). Returns a `taskkill` argv array.
 */
export function windowsGatewayKillArgs(pid: number): string[] {
	return ["taskkill", "/pid", String(pid), "/F"];
}
