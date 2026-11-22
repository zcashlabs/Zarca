// Locks the wallet when the computer sleeps.
//
// Linux: subscribe to logind's PrepareForSleep signal on the system bus.
// Everywhere: a monotonic-vs-wall clock gap detector catches suspends the bus
// signal missed (or platforms without logind).
import { spawn } from "node:child_process";

export function watchSleep(onSleep: () => void) {
	let lastWall = Date.now();
	let lastMono = performance.now();
	setInterval(() => {
		const wall = Date.now();
		const mono = performance.now();
		// Timers do not fire during suspend; a large wall-clock jump means we were asleep.
		// CLOCK_MONOTONIC stops during suspend on Linux, so the gap shows up only in wall time.
		if (wall - lastWall - (mono - lastMono) > 30_000) onSleep();
		lastWall = wall;
		lastMono = mono;
	}, 10_000);

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
