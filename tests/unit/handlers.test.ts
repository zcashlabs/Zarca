import { expect, test } from "bun:test";
import { createHandlers, dispatch } from "../../src/bun/rpc/handlers";
import type { Controller } from "../../src/bun/app/controller";

const host = { chooseFolder: async () => null, chooseFile: async () => null, openExternal: () => {}, copy: () => {} };

test("handlers reject unknown methods, non-dialog paths and non-https links", async () => {
	const controller = { get session() { return {}; }, unlocked: true } as unknown as Controller;
	const handlers = createHandlers(controller, host);
	await expect(dispatch(handlers, "constructor", {})).rejects.toThrow("Unknown method");
	await expect(dispatch(handlers, "__proto__", {})).rejects.toThrow("Unknown method");
	await expect(dispatch(handlers, "contacts.importApply", { path: "/etc/passwd", decisions: {} })).rejects.toThrow("Choose the file again");
	await expect(dispatch(handlers, "system.openExternal", { url: "file:///etc/passwd" })).rejects.toThrow("https");
	await expect(dispatch(handlers, "system.openExternal", { url: "javascript:alert(1)" })).rejects.toThrow("https");
});
