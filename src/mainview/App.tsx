import { useEffect, useState } from "react";
import type { ThemePreference } from "../shared/types";
import { useSession } from "./lib/hooks";
import { call, sessionChannel, syncChannel } from "./lib/rpc";
import { ToastProvider } from "./components/ui";
import { LockScreen } from "./screens/LockScreen";
import { Shell } from "./screens/Shell";

function useTheme(preference: ThemePreference | undefined) {
	const [system, setSystem] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => setSystem(media.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);
	const theme = preference === "light" || preference === "dark" ? preference : system ? "dark" : "light";
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);
}

export function App() {
	const session = useSession();
	const [booting, setBooting] = useState(true);
	useTheme(session?.settings.theme);

	useEffect(() => {
		let cancelled = false;
		const load = async (attempt = 0) => {
			try {
				const state = await call("session.get");
				if (cancelled) return;
				sessionChannel.emit(state);
				if (state.unlocked) {
					const sync = await call("session.sync");
					if (sync) syncChannel.emit(sync);
				}
				setBooting(false);
			} catch {
				if (!cancelled && attempt < 50) setTimeout(() => load(attempt + 1), 100);
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	if (booting || !session) {
		return <div className="flex h-full items-center justify-center bg-bg" />;
	}
	return <ToastProvider>{session.unlocked ? <Shell session={session} /> : <LockScreen session={session} />}</ToastProvider>;
}
