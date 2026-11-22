import type { ActivityItem } from "../../shared/types";
import { formatDate, formatShortDate, shortAddress } from "../lib/format";
import { ActivityIcon, FiatHint, PaymentStatusBadge, Zec } from "./domain";
import { Avatar, Badge, cx, Tag } from "./ui";

export function itemKey(item: ActivityItem) {
	return item.kind === "payment" ? `p:${item.payment.id}` : item.kind === "incoming" ? `i:${item.incoming.txid}` : `e:${item.external.txid}`;
}

export function ActivityRow({ item, today, onOpen, rate, currency, compact }: {
	item: ActivityItem;
	today: string;
	onOpen: (item: ActivityItem) => void;
	rate?: string | null;
	currency: string;
	compact?: boolean;
}) {
	let icon, title, subtitle, amount, status, tags: readonly string[] = [], when;
	if (item.kind === "payment") {
		const p = item.payment;
		const name = p.recipient.contactName ?? shortAddress(p.recipient.address);
		icon = p.recipient.contactName ? <Avatar name={p.recipient.contactName} size={36} /> : <ActivityIcon kind={p.recipient.route === "near-intents" ? "swap" : p.scheduleId ? "recurring" : "out"} />;
		title = name;
		subtitle = [
			p.recipient.route === "near-intents" ? `${p.recipient.assetSymbol ?? "Asset"} on ${p.recipient.chain.toUpperCase()}` : p.recipient.destinationLabel ?? "Zcash",
			p.scheduleId ? "Recurring" : null,
		].filter(Boolean).join(" · ");
		amount = <Zec zat={`-${p.amountZat}`} className="font-medium" />;
		status = <PaymentStatusBadge payment={p} today={today} />;
		tags = p.tags;
		when = p.settledAt ?? (p.dueDate ? `${p.dueDate}` : p.createdAt);
	} else if (item.kind === "incoming") {
		const i = item.incoming;
		icon = <ActivityIcon kind="in" />;
		title = i.kind === "received" ? "Received" : i.kind === "shielding" ? "Shielded funds" : "Internal transfer";
		subtitle = i.memos[0] ? `“${i.memos[0].slice(0, 60)}${i.memos[0].length > 60 ? "…" : ""}”` : i.minedHeight ? `Block ${i.minedHeight.toLocaleString()}` : "Awaiting confirmation";
		amount = <Zec zat={i.amountZat} sign className={cx("font-medium", i.kind === "received" && "text-success")} />;
		status = i.minedHeight === null ? <Badge tone="info" dot>Pending</Badge> : null;
		tags = i.tags;
		when = i.blockTime ?? item.at;
	} else {
		const e = item.external;
		icon = <ActivityIcon kind="out" />;
		title = "Sent from another wallet";
		subtitle = "Same recovery phrase, outside Zarca";
		amount = <Zec zat={`-${e.amountZat}`} className="font-medium" />;
		status = null;
		tags = e.tags;
		when = e.blockTime ?? item.at;
	}
	const amountZat = item.kind === "payment" ? item.payment.amountZat : item.kind === "incoming" ? item.incoming.amountZat : item.external.amountZat;
	return (
		<button
			type="button"
			onClick={() => onOpen(item)}
			className="group flex w-full items-center gap-3.5 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2"
		>
			{icon}
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13.5px] font-medium">{title}</span>
					{status}
				</div>
				<div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
					<span className="truncate">{subtitle}</span>
					{!compact && tags.slice(0, 3).map((t) => <Tag key={t}>{t}</Tag>)}
				</div>
			</div>
			<div className="flex flex-col items-end">
				{amount}
				<div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
					{!compact && <FiatHint zat={amountZat.replace("-", "")} rate={rate} currency={currency} />}
					<span>{when && /^\d{4}-\d{2}-\d{2}$/.test(when) ? formatShortDate(when) : formatDate(when)}</span>
				</div>
			</div>
		</button>
	);
}
