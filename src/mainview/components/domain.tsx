import { useMemo, useState } from "react";
import { encode } from "uqr";
import { ArrowDownLeft, ArrowUpRight, Eye, EyeOff, Repeat, Shuffle } from "lucide-react";
import type { PaymentStatus, PaymentView, SyncState } from "../../shared/types";
import { formatZec, fiat } from "../lib/format";
import { Badge, cx, Input } from "./ui";

export function Zec({ zat, sign, className, decimals, unit = true }: { zat: string | bigint; sign?: boolean; className?: string; decimals?: number; unit?: boolean }) {
	return (
		<span className={cx("num whitespace-nowrap", className)}>
			{formatZec(zat, { sign, decimals })}
			{unit && <span className="ml-1 text-[0.82em] font-medium text-muted">ZEC</span>}
		</span>
	);
}

export function FiatHint({ zat, rate, currency, className }: { zat: string | bigint; rate: string | null | undefined; currency: string; className?: string }) {
	const value = fiat(zat, rate, currency);
	if (!value) return null;
	return <span className={cx("num text-muted", className)}>≈ {value}</span>;
}

const STATUS: Record<PaymentStatus, { label: string; tone: "neutral" | "accent" | "success" | "danger" | "warning" | "info" }> = {
	scheduled: { label: "Scheduled", tone: "neutral" },
	draft: { label: "Draft", tone: "neutral" },
	submitting: { label: "Sending", tone: "info" },
	pending: { label: "Pending", tone: "info" },
	completed: { label: "Paid", tone: "success" },
	failed: { label: "Failed", tone: "danger" },
	unknown: { label: "Needs check", tone: "warning" },
	refunded: { label: "Refunded", tone: "warning" },
	skipped: { label: "Skipped", tone: "neutral" },
	cancelled: { label: "Cancelled", tone: "neutral" },
};

export function PaymentStatusBadge({ payment, today }: { payment: PaymentView; today?: string }) {
	if (payment.status === "scheduled" && payment.dueDate && today && payment.dueDate < today) {
		return <Badge tone="danger" dot>Overdue</Badge>;
	}
	if (payment.status === "pending" && payment.recipient.route === "near-intents") {
		const funded = payment.attempts.at(-1)?.txids.length;
		return <Badge tone="info" dot>{funded ? "Swapping" : "Funding"}</Badge>;
	}
	const s = STATUS[payment.status];
	return <Badge tone={s.tone} dot>{s.label}</Badge>;
}

export function ActivityIcon({ kind }: { kind: "out" | "in" | "swap" | "recurring" }) {
	const Icon = kind === "in" ? ArrowDownLeft : kind === "swap" ? Shuffle : kind === "recurring" ? Repeat : ArrowUpRight;
	return (
		<span
			className={cx(
				"flex size-9 shrink-0 items-center justify-center rounded-full",
				kind === "in" ? "bg-success-soft text-success" : kind === "swap" ? "bg-info-soft text-info" : "bg-surface-2 text-text-2",
			)}
		>
			<Icon className="size-4" />
		</span>
	);
}

export function QrCode({ value, size = 220 }: { value: string; size?: number }) {
	const path = useMemo(() => {
		const { data, size: n } = encode(value, { ecc: "M", border: 0 });
		let d = "";
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (data[y]![x]) d += `M${x},${y}h1v1h-1z`;
		return { d, n };
	}, [value]);
	return (
		<div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5" style={{ width: size + 32 }}>
			<svg viewBox={`0 0 ${path.n} ${path.n}`} width={size} height={size} shapeRendering="crispEdges" role="img" aria-label="QR code">
				<path d={path.d} fill="#111" />
			</svg>
		</div>
	);
}

export function SyncDot({ sync }: { sync: SyncState | null }) {
	const phase = sync?.phase ?? "connecting";
	const color = phase === "synced" ? "bg-success" : phase === "error" ? "bg-danger" : phase === "stopped" ? "bg-muted" : "bg-warning";
	return (
		<span className="relative flex size-2">
			{(phase === "syncing" || phase === "connecting") && <span className={cx("absolute inline-flex size-full animate-ping rounded-full opacity-60", color)} />}
			<span className={cx("relative inline-flex size-2 rounded-full", color)} />
		</span>
	);
}

export function syncLabel(sync: SyncState | null, compact = false): string {
	if (!sync) return "Connecting…";
	switch (sync.phase) {
		case "synced":
			return sync.tipHeight && !compact ? `Synced · block ${sync.tipHeight.toLocaleString()}` : "Synced";
		case "syncing":
			return sync.progress !== null && sync.progress < 1 ? `Syncing ${Math.floor(sync.progress * 100)}%` : "Syncing…";
		case "error":
			return "Sync error";
		case "stopped":
			return "Sync stopped";
		default:
			return "Connecting…";
	}
}

export function PasswordInput({ value, onChange, placeholder, autoFocus, invalid, id, autoComplete = "current-password", onEnter }: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	autoFocus?: boolean;
	invalid?: boolean;
	id?: string;
	autoComplete?: string;
	onEnter?: () => void;
}) {
	const [shown, setShown] = useState(false);
	return (
		<Input
			id={id}
			type={shown ? "text" : "password"}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			autoFocus={autoFocus}
			invalid={invalid}
			autoComplete={autoComplete}
			spellCheck={false}
			onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
			suffix={
				<button type="button" tabIndex={-1} onClick={() => setShown(!shown)} className="rounded-md p-1.5 text-muted hover:text-text" aria-label={shown ? "Hide password" : "Show password"}>
					{shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
				</button>
			}
		/>
	);
}

/** Password strength hint without external dependencies. */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3; label: string } {
	if (password.length < 8) return { score: 0, label: "Too short" };
	let variety = 0;
	if (/[a-z]/.test(password)) variety++;
	if (/[A-Z]/.test(password)) variety++;
	if (/\d/.test(password)) variety++;
	if (/[^A-Za-z0-9]/.test(password)) variety++;
	const long = password.length >= 14;
	if (long && variety >= 2) return { score: 3, label: "Strong" };
	if (password.length >= 10 && variety >= 2) return { score: 2, label: "Good" };
	return { score: 1, label: "Weak" };
}

export function StrengthMeter({ password }: { password: string }) {
	const { score, label } = passwordStrength(password);
	if (!password) return null;
	return (
		<div className="flex items-center gap-2">
			<div className="flex flex-1 gap-1">
				{[1, 2, 3].map((i) => (
					<span key={i} className={cx("h-1 flex-1 rounded-full transition", score >= i ? (score === 1 ? "bg-danger" : score === 2 ? "bg-warning" : "bg-success") : "bg-surface-3")} />
				))}
			</div>
			<span className="w-16 text-right text-xs text-muted">{label}</span>
		</div>
	);
}
