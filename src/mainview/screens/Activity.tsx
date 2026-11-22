import { useMemo, useState } from "react";
import { CalendarPlus, Filter, Inbox, Repeat, Search, X } from "lucide-react";
import type { ActivityItem, PaymentView } from "../../shared/types";
import { useQuery } from "../lib/hooks";
import { addDaysLocal, formatDate, today as localToday } from "../lib/format";
import { Button, Card, cx, Empty, Input, Segmented, Select, Skeleton, Tag } from "../components/ui";
import { ActivityRow, itemKey } from "../components/ActivityRow";
import { ActivityDetail } from "../components/ActivityDetail";
import { PageHeader, useShell } from "./Shell";
import { Schedules } from "./Schedules";

type View = "current" | "past" | "future" | "schedules";
type Window = "day" | "week" | "month";
type Sort = "newest" | "oldest" | "largest";

const OPEN = new Set(["scheduled", "draft"]);
const IN_FLIGHT = new Set(["submitting", "pending", "unknown", "failed", "refunded"]);

function windowEnd(today: string, w: Window) {
	return w === "day" ? today : w === "week" ? addDaysLocal(today, 6) : addDaysLocal(today, 30);
}
function windowStart(today: string, w: Window) {
	return w === "day" ? today : w === "week" ? addDaysLocal(today, -6) : addDaysLocal(today, -30);
}

function dayOf(item: ActivityItem): string {
	if (item.kind === "payment") {
		const p = item.payment;
		if (OPEN.has(p.status) && p.dueDate) return p.dueDate;
		return (p.settledAt ?? p.updatedAt).slice(0, 10);
	}
	return item.at.slice(0, 10);
}

function amountOf(item: ActivityItem): bigint {
	const v = item.kind === "payment" ? item.payment.amountZat : item.kind === "incoming" ? item.incoming.amountZat : item.external.amountZat;
	const n = BigInt(v);
	return n < 0n ? -n : n;
}

export function Activity() {
	const shell = useShell();
	const [view, setView] = useState<View>((shell.focus as View) ?? "current");
	const [window, setWindow] = useState<Window>("week");
	const [query, setQuery] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [direction, setDirection] = useState<"all" | "in" | "out">("all");
	const [sort, setSort] = useState<Sort>("newest");
	const [open, setOpen] = useState<ActivityItem | null>(null);
	const { data, loading, refresh } = useQuery("activity.list");
	const { data: allTags } = useQuery("tags.list");
	const { data: overview } = useQuery("overview.get");
	const currency = shell.session.walletSettings?.fiatCurrency ?? "USD";
	const today = localToday();
	const end = windowEnd(today, window);
	const start = windowStart(today, window);

	const buckets = useMemo(() => {
		const current: ActivityItem[] = [];
		const past: ActivityItem[] = [];
		const future: ActivityItem[] = [];
		for (const item of data ?? []) {
			const day = dayOf(item);
			if (item.kind === "payment") {
				const p = item.payment;
				if (OPEN.has(p.status)) {
					if (p.dueDate && p.dueDate > end) future.push(item);
					else current.push(item); // overdue and due in window
					continue;
				}
				if (IN_FLIGHT.has(p.status)) {
					current.push(item);
					continue;
				}
			} else if ((item.kind === "incoming" && item.incoming.minedHeight === null) || (item.kind === "external" && item.external.minedHeight === null)) {
				current.push(item);
				continue;
			}
			if (day >= start) current.push(item);
			else past.push(item);
		}
		return { current, past, future };
	}, [data, start, end]);

	const filtered = useMemo(() => {
		if (view === "schedules") return [];
		const q = query.trim().toLowerCase();
		const list = buckets[view].filter((item) => {
			const itemTags = item.kind === "payment" ? item.payment.tags : item.kind === "incoming" ? item.incoming.tags : item.external.tags;
			if (tags.length && !tags.every((t) => itemTags.some((x) => x.toLowerCase() === t.toLowerCase()))) return false;
			if (direction === "in" && item.kind !== "incoming") return false;
			if (direction === "out" && item.kind === "incoming") return false;
			if (q) {
				const text =
					item.kind === "payment"
						? [item.payment.recipient.contactName, item.payment.recipient.address, item.payment.memo, item.payment.note, ...item.payment.tags].join(" ")
						: item.kind === "incoming"
							? [item.incoming.txid, item.incoming.note, ...item.incoming.memos, ...item.incoming.tags].join(" ")
							: [item.external.txid, item.external.note, ...item.external.tags].join(" ");
				if (!text.toLowerCase().includes(q)) return false;
			}
			return true;
		});
		const priority = (item: ActivityItem) =>
			item.kind === "payment" && item.payment.status === "scheduled" && item.payment.dueDate && item.payment.dueDate < today
				? 0
				: item.kind === "payment" && ["unknown", "failed", "refunded"].includes(item.payment.status)
					? 1
					: 2;
		return list.sort((a, b) => {
			if (view === "current") {
				const p = priority(a) - priority(b);
				if (p) return p;
			}
			if (sort === "largest") return amountOf(b) > amountOf(a) ? 1 : -1;
			const order = view === "future" ? dayOf(a).localeCompare(dayOf(b)) : b.at.localeCompare(a.at);
			return sort === "oldest" ? -order : order;
		});
	}, [buckets, view, query, tags, direction, sort, today]);

	const overdue = buckets.current.filter((i) => i.kind === "payment" && i.payment.status === "scheduled" && i.payment.dueDate! < today).length;
	const filtersActive = tags.length > 0 || direction !== "all" || query.trim() !== "";

	return (
		<>
			<PageHeader
				title="Activity"
				subtitle="Payments, receipts and scheduled obligations"
				actions={view === "schedules" ? null : <Button icon={<CalendarPlus className="size-4" />} onClick={() => setView("schedules")}>Recurring payments</Button>}
			/>
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<Segmented
					value={view}
					onChange={setView}
					options={[
						{ value: "current", label: "Current", count: overdue || undefined },
						{ value: "past", label: "Past" },
						{ value: "future", label: "Upcoming", count: buckets.future.length || undefined },
						{ value: "schedules", label: <span className="flex items-center gap-1.5"><Repeat className="size-3.5" /> Schedules</span> },
					]}
				/>
				{view === "current" && (
					<Segmented
						value={window}
						onChange={setWindow}
						options={[
							{ value: "day", label: "Today" },
							{ value: "week", label: "This week" },
							{ value: "month", label: "30 days" },
						]}
					/>
				)}
			</div>
			{view === "schedules" ? (
				<Schedules />
			) : (
				<Card padded={false}>
					<div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
						<div className="relative min-w-56 flex-1">
							<Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" />
							<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names, memos, notes, tags…" className="h-9 pl-9" />
						</div>
						<Select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} className="h-9 w-36">
							<option value="all">All activity</option>
							<option value="out">Outgoing</option>
							<option value="in">Incoming</option>
						</Select>
						<Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-9 w-36">
							<option value="newest">{view === "future" ? "Soonest" : "Newest"}</option>
							<option value="oldest">{view === "future" ? "Latest" : "Oldest"}</option>
							<option value="largest">Largest</option>
						</Select>
					</div>
					{(allTags?.length ?? 0) > 0 && (
						<div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5">
							<Filter className="mr-1 size-3.5 text-muted" />
							{allTags!.slice(0, 16).map(({ tag }) => (
								<Tag key={tag} active={tags.includes(tag)} onClick={() => setTags(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag])}>{tag}</Tag>
							))}
							{filtersActive && (
								<button type="button" onClick={() => { setTags([]); setDirection("all"); setQuery(""); }} className="ml-auto flex items-center gap-1 text-xs text-muted hover:text-text">
									<X className="size-3" /> Clear filters
								</button>
							)}
						</div>
					)}
					<div className="px-2 py-2">
						{loading ? (
							<div className="flex flex-col gap-3 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11" />)}</div>
						) : filtered.length === 0 ? (
							<Empty icon={<Inbox className="size-5" />} title={filtersActive ? "Nothing matches these filters" : view === "future" ? "Nothing scheduled beyond this window" : view === "past" ? "No earlier activity" : "Nothing in this window"}>
								{view === "current" ? `Showing ${formatDate(start)} – ${formatDate(end)}, plus anything overdue or in progress.` : undefined}
							</Empty>
						) : (
							<GroupedList items={filtered} view={view} today={today} onOpen={setOpen} rate={overview?.fiat?.rate ?? null} currency={currency} grouped={sort !== "largest"} />
						)}
					</div>
				</Card>
			)}
			<ActivityDetail item={open} today={today} onClose={() => { setOpen(null); void refresh(); }} />
		</>
	);
}

function GroupedList({ items, view, today, onOpen, rate, currency, grouped }: {
	items: ActivityItem[];
	view: View;
	today: string;
	onOpen: (i: ActivityItem) => void;
	rate: string | null;
	currency: string;
	grouped: boolean;
}) {
	const groups: { label: string; tone?: "danger"; items: ActivityItem[] }[] = [];
	for (const item of items) {
		const p: PaymentView | null = item.kind === "payment" ? item.payment : null;
		let label: string;
		let tone: "danger" | undefined;
		if (view === "current" && p?.status === "scheduled" && p.dueDate && p.dueDate < today) {
			label = "Overdue";
			tone = "danger";
		} else if (view === "current" && p && ["unknown", "failed", "refunded"].includes(p.status)) label = "Needs attention";
		else if (view === "current" && p && ["submitting", "pending"].includes(p.status)) label = "In progress";
		else if (view === "current" && p && OPEN.has(p.status)) label = "Due";
		else if (!grouped) label = "";
		else label = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(`${dayOf(item)}T12:00:00`));
		const last = groups.at(-1);
		if (last && last.label === label) last.items.push(item);
		else groups.push({ label, tone, items: [item] });
	}
	return (
		<div className="flex flex-col">
			{groups.map((g, i) => (
				<div key={`${g.label}-${i}`}>
					{g.label && <div className={cx("px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide", g.tone === "danger" ? "text-danger" : "text-muted")}>{g.label}</div>}
					{g.items.map((item) => <ActivityRow key={itemKey(item)} item={item} today={today} onOpen={onOpen} rate={rate} currency={currency} />)}
				</div>
			))}
		</div>
	);
}
