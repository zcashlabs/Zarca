// Locks the wallet when the computer sleeps.
//
// Linux: subscribe to logind's PrepareForSleep signal on the system bus, which
// locks before the machine sleeps.
// Everywhere (macOS and Windows have no hook in Electrobun yet): a late-timer
// detector locks right after resume.
import { spawn } from "node:child_process";

const TICK_MS = 10_000;
const SLEEP_GAP_MS = 30_000;

/**
 * Whether the process was suspended between two ticks. Timers do not fire while
 * the machine sleeps, so a tick far later than scheduled means we were asleep.
 * Which clock shows the gap differs by OS (Linux CLOCK_MONOTONIC stops during
 * suspend; Windows and macOS monotonic clocks may keep counting), so either
 * clock running late counts. A long event-loop stall also locks, which is safe.
 */
export function sleptBetween(previous: { wall: number; mono: number }, now: { wall: number; mono: number }): boolean {
	const late = Math.max(now.wall - previous.wall, now.mono - previous.mono) - TICK_MS;
	return late > SLEEP_GAP_MS;
}

export function watchSleep(onSleep: () => void) {
	let last = { wall: Date.now(), mono: performance.now() };
	setInterval(() => {
		const now = { wall: Date.now(), mono: performance.now() };
		if (sleptBetween(last, now)) onSleep();
		last = now;
	}, TICK_MS);

	if (process.platform !== "linux") return;
	try {
		const monitor = spawn(
			"gdbus",
			["monitor", "--system", "--dest", "org.freedesktop.login1", "--object-path", "/org/freedesktop/login1"],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		monitor.on("error", () => {});
		let buffer = "";
		monitor.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.includes("PrepareForSleep") && line.includes("(true")) onSleep();
			}
		});
		process.on("exit", () => monitor.kill());
	} catch {
		// The clock detector above still applies.
	}
}
