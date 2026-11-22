import { createContext, useContext, useState, type ReactNode } from "react";
import { BarChart3, Download, LayoutDashboard, ListOrdered, Lock, Send, Settings, Users } from "lucide-react";
import type { SendDraft, SessionState } from "../../shared/types";
import { useSync } from "../lib/hooks";
import { call } from "../lib/rpc";
import { Badge, Button, cx } from "../components/ui";
import { SyncDot, syncLabel } from "../components/domain";
import { Logo } from "../components/Logo";
import { Overview } from "./Overview";
import { Activity } from "./Activity";
import { Contacts } from "./Contacts";
import { Reports } from "./Reports";
import { SettingsScreen } from "./Settings";
import { SendFlow } from "./Send";
import { ReceiveModal } from "./Receive";

export type Route = "overview" | "activity" | "contacts" | "reports" | "settings";

interface ShellActions {
	session: SessionState;
	navigate: (route: Route, focus?: string) => void;
	send: (prefill?: Partial<SendDraft>) => void;
	receive: () => void;
	focus: string | null;
}

const ShellContext = createContext<ShellActions | null>(null);
export const useShell = () => {
	const value = useContext(ShellContext);
	if (!value) throw new Error("Shell context missing");
	return value;
};

const NAV: { route: Route; label: string; icon: typeof LayoutDashboard }[] = [
	{ route: "overview", label: "Overview", icon: LayoutDashboard },
	{ route: "activity", label: "Activity", icon: ListOrdered },
	{ route: "contacts", label: "Contacts", icon: Users },
	{ route: "reports", label: "Reports", icon: BarChart3 },
	{ route: "settings", label: "Settings", icon: Settings },
];

export function Shell({ session }: { session: SessionState }) {
	const [route, setRoute] = useState<Route>("overview");
	const [focus, setFocus] = useState<string | null>(null);
	const [send, setSend] = useState<{ prefill?: Partial<SendDraft>; key: number } | null>(null);
	const [receive, setReceive] = useState(false);
	const sync = useSync();
	const wallet = session.unlocked!;

	const actions: ShellActions = {
		session,
		focus,
		navigate: (next, target) => {
			setRoute(next);
			setFocus(target ?? null);
		},
		send: (prefill) => setSend({ prefill, key: Date.now() }),
		receive: () => setReceive(true),
	};

	return (
		<ShellContext.Provider value={actions}>
			<div className="flex h-full">
				<aside className="flex w-[244px] shrink-0 flex-col border-r border-border bg-sidebar">
					<div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
						<Logo size={26} />
						<span className="text-[15px] font-semibold tracking-tight">Zarca</span>
					</div>
					<div className="px-3">
						<button
							type="button"
							onClick={() => actions.navigate("settings", "wallets")}
							className="flex w-full items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5 text-left shadow-sm transition hover:border-border-strong"
							title="Switch wallet"
						>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] font-semibold">{wallet.name}</span>
								<span className="block text-[11px] text-muted">{wallet.network === "mainnet" ? "Mainnet" : "Testnet"} wallet</span>
							</span>
							{wallet.network === "testnet" && <Badge tone="warning">Test</Badge>}
						</button>
					</div>
					<div className="px-3 pt-4">
						<Button variant="primary" size="lg" className="w-full" icon={<Send className="size-4" />} onClick={() => actions.send()}>
							Send
						</Button>
						<Button variant="ghost" size="md" className="mt-1.5 w-full" icon={<Download className="size-4" />} onClick={() => setReceive(true)}>
							Receive
						</Button>
					</div>
					<nav className="mt-4 flex flex-col gap-0.5 px-3" aria-label="Main">
						{NAV.map(({ route: r, label, icon: Icon }) => (
							<button
								key={r}
								type="button"
								onClick={() => actions.navigate(r)}
								aria-current={route === r ? "page" : undefined}
								className={cx(
									"flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition",
									route === r ? "bg-surface text-text shadow-sm ring-1 ring-border" : "text-text-2 hover:bg-surface/60 hover:text-text",
								)}
							>
								<Icon className={cx("size-4", route === r ? "text-accent" : "text-muted")} />
								{label}
							</button>
						))}
					</nav>
					<div className="mt-auto border-t border-border px-4 py-3.5">
						<div className="flex items-center gap-2.5" title={sync?.error ?? undefined}>
							<SyncDot sync={sync} />
							<span className="num min-w-0 flex-1 truncate text-xs text-muted">{syncLabel(sync)}</span>
							<button
								type="button"
								onClick={() => void call("session.lock", { reason: "manual" })}
								className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-text-2 hover:bg-surface hover:text-text"
								title="Lock wallet"
							>
								<Lock className="size-3.5" /> Lock
							</button>
						</div>
						{sync?.phase === "error" && sync.error && <p className="mt-2 text-[11px] leading-snug text-danger">{sync.error}</p>}
					</div>
				</aside>
				<main className="min-w-0 flex-1 overflow-y-auto">
					<div key={route} className="mx-auto max-w-[1120px] px-8 py-7 animate-fade">
						{route === "overview" && <Overview />}
						{route === "activity" && <Activity />}
						{route === "contacts" && <Contacts />}
						{route === "reports" && <Reports />}
						{route === "settings" && <SettingsScreen />}
					</div>
				</main>
			</div>
			{send && <SendFlow key={send.key} prefill={send.prefill} onClose={() => setSend(null)} />}
			<ReceiveModal open={receive} onClose={() => setReceive(false)} />
		</ShellContext.Provider>
	);
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
	return (
		<div className="mb-6 flex items-end justify-between gap-4">
			<div>
				<h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
				{subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</div>
	);
}
