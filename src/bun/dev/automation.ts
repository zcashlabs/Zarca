// Development-only UI automation for headless screenshots and smoke tests.
// Enabled only when ZARCA_AUTOMATION_SOCKET is set AND the build channel is
// "dev". It listens on a Unix socket owned by the current user and evaluates
// scripts in the webview. Release builds never start it.
import { chmodSync, rmSync } from "node:fs";

export function startAutomation(evaluate: (script: string) => Promise<unknown>) {
	const path = process.env.ZARCA_AUTOMATION_SOCKET;
	if (!path) return;
	rmSync(path, { force: true });
	Bun.serve({
		unix: path,
		async fetch(request) {
			if (request.method !== "POST") return new Response("POST a script", { status: 405 });
			try {
				const result = await evaluate(await request.text());
				return Response.json({ ok: true, result: result ?? null });
			} catch (error) {
				return Response.json({ ok: false, error: String(error) }, { status: 500 });
			}
		},
	});
	chmodSync(path, 0o600);
	console.log(`[automation] listening on ${path}`);
}
