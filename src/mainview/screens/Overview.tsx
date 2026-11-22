import { useState } from "react";
import { AlertCircle, ArrowRight, CalendarClock, Inbox, ShieldAlert } from "lucide-react";
import type { ActivityItem } from "../../shared/types";
import { useQuery, useSync } from "../lib/hooks";
import { fiat, formatDateTime, formatShortDate, today as localToday } from "../lib/format";
import { Badge, Button, Card, CardHeader, Callout, cx, Empty, Skeleton } from "../components/ui";
import { FiatHint, PaymentStatusBadge, SyncDot, syncLabel, Zec } from "../components/domain";
import { ActivityRow, itemKey } from "../components/ActivityRow";
import { ActivityDetail } from "../components/ActivityDetail";
import { PageHeader, useShell } from "./Shell";

export function Overview() {
	const { data, error, refresh } = useQuery("overview.get");
	const sync = useSync();
	const shell = useShell();
	const [open, setOpen] = useState<ActivityItem | null>(null);
	const currency = shell.session.walletSettings?.fiatCurrency ?? "USD";
	const today = localToday();
	const rate = data?.fiat?.rate ?? null;

	if (error && !data) {
		return (
			<>
				<PageHeader title="Overview" />
				<Callout tone="danger" title="Could not load the overview">{error}</Callout>
				<Button className="mt-4" onClick={() => refresh()}>Try again</Button>
			</>
		);
	}

	const spendable = BigInt(data?.balance.spendable ?? "0");
	const committed = BigInt(data?.upcomingTotal ?? "0") + BigInt(data?.overdueTotal ?? "0");
	const coverage = committed === 0n ? 1 : Math.min(1, Number(spendable) / Number(committed));

	return (
		<>
			<PageHeader title="Overview" subtitle={shell.session.unlocked?.name} />
			<div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.45fr_1fr]">
				<Card className="relative overflow-hidden">
					<div className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full opacity-60" style={{ background: "radial-gradient(closest-side, var(--accent-soft), transparent)" }} />
					<div className="relative">
						<div className="flex items-center justify-between">
							<span className="text-[13px] font-medium text-muted">Spendable balance</span>
							<span className="flex items-center gap-2 text-xs text-muted" title={sync?.error ?? undefined}>
								<SyncDot sync={sync} /> {syncLabel(sync)}
							</span>
						</div>
						{data ? (
							<>
								<div className="mt-2 flex items-baseline gap-2">
									<Zec zat={data.balance.spendable} className="text-[38px] font-semibold leading-none tracking-tight" decimals={8} unit={false} />
									<span className="text-lg font-medium text-muted">ZEC</span>
								</div>
								<div className="mt-2 h-5 text-sm">
									{data.fiat ? (
										<span className="num text-text-2">
											≈ {fiat(data.balance.spendable, data.fiat.rate, currency)}
											<span className={cx("ml-2 text-xs", data.fiat.stale ? "text-warning" : "text-muted")}>
												{data.fiat.stale ? "Stale rate · " : ""}{data.fiat.source} · {formatDateTime(data.fiat.observedAt)}
											</span>
										</span>
									) : (
										<span className="text-xs text-muted">Fiat value unavailable</span>
									)}
								</div>
							</>
						) : (
							<>
								<Skeleton className="mt-3 h-9 w-64" />
								<Skeleton className="mt-3 h-4 w-40" />
							</>
						)}
						<div className="mt-6 grid grid-cols-3 gap-3 border-t border-border pt-4">
							<Stat label="Total balance" zat={data?.balance.total} rate={rate} currency={currency} />
							<Stat label="Pending" zat={data?.balance.pending} hint="Awaiting confirmations" />
							<Stat label="Reserved" zat={data?.balance.locked} hint="Held by payments in progress" />
						</div>
						{data && BigInt(data.balance.unshielded) > 0n && (
							<Callout tone="info" className="mt-4">
								<Zec zat={data.balance.unshielded} /> is in older pools and is not spendable until it is moved to Ironwood.
							</Callout>
						)}
					</div>
				</Card>

				<Card>
					<CardHeader title="Commitments" subtitle="Scheduled payments compared with spendable funds" />
					<div className="grid grid-cols-2 gap-3">
						<div className={cx("rounded-xl p-3.5", BigInt(data?.overdueTotal ?? "0") > 0n ? "bg-danger-soft/60" : "bg-surface-2")}>
							<div className={cx("text-xs font-medium", BigInt(data?.overdueTotal ?? "0") > 0n ? "text-danger" : "text-text-2")}>Overdue</div>
							<Zec zat={data?.overdueTotal ?? "0"} className="mt-1 block text-lg font-semibold" />
							<FiatHint zat={data?.overdueTotal ?? "0"} rate={rate} currency={currency} className="text-xs" />
						</div>
						<div className="rounded-xl bg-surface-2 p-3.5">
							<div className="text-xs font-medium text-text-2">Upcoming (31 days)</div>
							<Zec zat={data?.upcomingTotal ?? "0"} className="mt-1 block text-lg font-semibold" />
							<FiatHint zat={data?.upcomingTotal ?? "0"} rate={rate} currency={currency} className="text-xs" />
						</div>
					</div>
					<div className="mt-5">
						<div className="mb-1.5 flex justify-between text-xs text-muted">
							<span>Covered by spendable funds</span>
							<span className="num">{committed === 0n ? "—" : `${Math.round(coverage * 100)}%`}</span>
						</div>
						<div className="h-2 overflow-hidden rounded-full bg-surface-3">
							<div className={cx("h-full rounded-full transition-all", coverage >= 1 ? "bg-success" : coverage > 0.5 ? "bg-warning" : "bg-danger")} style={{ width: `${coverage * 100}%` }} />
						</div>
						{committed > spendable && (
							<p className="mt-2 text-xs text-warning">
								Short by <Zec zat={committed - spendable} /> for scheduled payments. Scheduled payments do not reserve funds.
							</p>
						)}
					</div>
				</Card>
			</div>

			<div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
				<Card>
					<CardHeader
						title={<span className="flex items-center gap-2">Needs attention {data?.attention.length ? <Badge tone="danger">{data.attention.length}</Badge> : null}</span>}
						action={<Button variant="ghost" size="sm" onClick={() => shell.navigate("activity", "current")}>View all <ArrowRight className="size-3.5" /></Button>}
					/>
					{!data ? (
						<ListSkeleton />
					) : data.attention.length === 0 ? (
						<Empty icon={<ShieldAlert className="size-5" />} title="All clear">Nothing is overdue or waiting for a decision.</Empty>
					) : (
						<div className="-mx-3 flex flex-col">
							{data.attention.map((p) => (
								<button key={p.id} type="button" onClick={() => setOpen({ kind: "payment", at: p.createdAt, payment: p })} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-2">
									<AlertCircle className={cx("size-4 shrink-0", p.status === "unknown" || p.status === "refunded" ? "text-warning" : "text-danger")} />
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13.5px] font-medium">{p.recipient.contactName ?? "Payment"}</div>
										<div className="text-xs text-muted">{p.dueDate ? `Due ${formatShortDate(p.dueDate)}` : attentionReason(p.status)}</div>
									</div>
									<PaymentStatusBadge payment={p} today={today} />
									<Zec zat={p.amountZat} className="text-[13px] font-medium" />
								</button>
							))}
						</div>
					)}
				</Card>
				<Card>
					<CardHeader
						title="Upcoming this week"
						action={<Button variant="ghost" size="sm" onClick={() => shell.navigate("activity", "future")}>Schedules <ArrowRight className="size-3.5" /></Button>}
					/>
					{!data ? (
						<ListSkeleton />
					) : data.upcoming.length === 0 ? (
						<Empty icon={<CalendarClock className="size-5" />} title="No payments due this week" />
					) : (
						<div className="-mx-3 flex flex-col">
							{data.upcoming.map((p) => (
								<button key={p.id} type="button" onClick={() => setOpen({ kind: "payment", at: p.createdAt, payment: p })} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-2">
									<div className="flex w-11 shrink-0 flex-col items-center rounded-lg bg-surface-2 py-1">
										<span className="text-[10px] font-semibold uppercase text-muted">{formatShortDate(p.dueDate!).split(" ")[0]}</span>
										<span className="num text-sm font-semibold leading-tight">{p.dueDate!.slice(8)}</span>
									</div>
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13.5px] font-medium">{p.recipient.contactName ?? "Payment"}</div>
										<div className="text-xs text-muted">{p.tags.join(", ") || "Recurring"}</div>
									</div>
									<Zec zat={p.amountZat} className="text-[13px] font-medium" />
								</button>
							))}
						</div>
					)}
				</Card>
			</div>

			<Card className="mt-5">
				<CardHeader title="Recent activity" action={<Button variant="ghost" size="sm" onClick={() => shell.navigate("activity")}>All activity <ArrowRight className="size-3.5" /></Button>} />
				{!data ? (
					<ListSkeleton />
				) : data.recent.length === 0 ? (
					<Empty icon={<Inbox className="size-5" />} title="No activity yet" action={<Button variant="primary" onClick={() => shell.receive()}>Receive ZEC</Button>}>
						Transactions appear here once they are sent or received.
					</Empty>
				) : (
					<div className="-mx-3 flex flex-col">
						{data.recent.map((item) => (
							<ActivityRow key={itemKey(item)} item={item} today={today} onOpen={setOpen} rate={rate} currency={currency} />
						))}
					</div>
				)}
			</Card>
			<ActivityDetail item={open} today={today} onClose={() => { setOpen(null); void refresh(); }} />
		</>
	);
}

function attentionReason(status: string) {
	return status === "unknown" ? "Outcome needs checking" : status === "refunded" ? "Swap refunded" : status === "failed" ? "Failed — retry available" : "";
}

function Stat({ label, zat, rate, currency, hint }: { label: string; zat?: string; rate?: string | null; currency?: string; hint?: string }) {
	return (
		<div title={hint}>
			<div className="text-xs text-muted">{label}</div>
			{zat === undefined ? <Skeleton className="mt-1.5 h-5 w-24" /> : <Zec zat={zat} className="mt-0.5 block text-[15px] font-semibold" />}
			{rate && currency && zat && <FiatHint zat={zat} rate={rate} currency={currency} className="text-xs" />}
		</div>
	);
}

function ListSkeleton() {
	return (
		<div className="flex flex-col gap-3">
			{[0, 1, 2].map((i) => (
				<div key={i} className="flex items-center gap-3">
					<Skeleton className="size-9 rounded-full" />
					<div className="flex-1"><Skeleton className="h-3.5 w-40" /><Skeleton className="mt-1.5 h-3 w-24" /></div>
					<Skeleton className="h-4 w-20" />
				</div>
			))}
		</div>
	);
}
