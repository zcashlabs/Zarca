import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

// Dev automation evaluates scripts in the webview; only those builds relax script-src.
const automationCsp = {
	name: "zarca-automation-csp",
	transformIndexHtml(html: string) {
		return process.env.ZARCA_AUTOMATION_SOCKET ? html.replace("script-src 'self' views:", "script-src 'self' views: 'unsafe-eval'") : html;
	},
};

export default defineConfig({
	plugins: [react(), tailwindcss(), automationCsp],
	resolve: {
		alias: electrobunViteAliases(resolve(__dirname, ".hutch/devkit")),
	},
	root: "src/mainview",
	base: "./",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		target: "es2022",
		chunkSizeWarningLimit: 1500,
	},
	server: {
		port: 5173,
		strictPort: true,
	},
});
