import { useEffect, useState } from "react";
import { CalendarX, CheckCircle2, CircleDashed, RefreshCw, Send, SkipForward, XCircle } from "lucide-react";
import type { ActivityItem, AttemptView, PaymentView, ValuationView } from "../../shared/types";
import { call } from "../lib/rpc";
import { useAction, useQuery } from "../lib/hooks";
import { formatDate, formatDateTime, formatFiat, fiat, shortAddress } from "../lib/format";
import { useShell } from "../screens/Shell";
import { PaymentStatusBadge, Zec } from "./domain";
import { Badge, Button, Callout, Confirm, CopyButton, cx, Drawer, ErrorText, Field, KeyValue, Mono, TagInput, Textarea, useToast } from "./ui";

export function ActivityDetail({ item, today, onClose }: { item: ActivityItem | null; today: string; onClose: () => void }) {
	if (!item) return null;
	return item.kind === "payment" ? (
		<PaymentDetail paymentId={item.payment.id} initial={item.payment} today={today} onClose={onClose} />
	) : (
		<ChainDetail item={item} onClose={onClose} />
	);
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
	return (
		<section className={cx("mt-6", className)}>
			<h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h4>
			{children}
		</section>
	);
}

function Valuation({ valuation, zat }: { valuation: ValuationView | null; zat: string }) {
	if (!valuation) return <span className="text-muted">Not recorded</span>;
	return (
		<span className="flex flex-col items-end">
			<span className="num">{fiat(zat, valuation.rate, valuation.currency)}</span>
			<span className="text-xs text-muted">
				{formatFiat(valuation.rate, valuation.currency)}/ZEC · {valuation.source} · {formatDateTime(valuation.observedAt)}
			</span>
		</span>
	);
}

function Annotations({ note, tags, onSave }: { note: string | null; tags: readonly string[]; onSave: (note: string | null, tags: string[]) => Promise<void> }) {
	const [draftNote, setNote] = useState(note ?? "");
	const [draftTags, setTags] = useState<string[]>([...tags]);
	const { data: allTags } = useQuery("tags.list");
	const save = useAction(onSave);
	const toast = useToast();
	useEffect(() => {
		setNote(note ?? "");
		setTags([...tags]);
	}, [note, tags]);
	const dirty = draftNote !== (note ?? "") || draftTags.join("\n") !== tags.join("\n");
	return (
		<div className="flex flex-col gap-3">
			<Field label="Tags">
				<TagInput value={draftTags} onChange={setTags} suggestions={allTags?.map((t) => t.tag) ?? []} />
			</Field>
			<Field label="Private note" hint="Stored encrypted on this computer only. Never sent to the recipient.">
				<Textarea value={draftNote} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
			</Field>
			{save.error && <ErrorText>{save.error}</ErrorText>}
			{dirty && (
				<div className="flex justify-end">
					<Button
						size="sm"
						variant="primary"
						loading={save.pending}
						onClick={async () => {
							await save.run(draftNote.trim() || null, draftTags);
							toast("success", "Saved");
						}}
					>
						Save changes
					</Button>
				</div>
			)}
		</div>
	);
}

function AttemptRow({ attempt, index }: { attempt: AttemptView; index: number }) {
	const icon =
		attempt.status === "confirmed" ? <CheckCircle2 className="size-4 text-success" /> : attempt.status === "failed" || attempt.status === "abandoned" ? <XCircle className="size-4 text-danger" /> : <CircleDashed className="size-4 text-info" />;
	const near = attempt.near;
	return (
		<div className="rounded-xl border border-border p-3.5">
			<div className="flex items-center gap-2 text-[13px] font-medium">
				{icon} Attempt {index + 1}
				<span className="ml-auto text-xs font-normal text-muted">{formatDateTime(attempt.createdAt)}</span>
			</div>
			{attempt.error && <p className="mt-2 text-[13px] text-text-2">{attempt.error}</p>}
			<dl className="mt-1 divide-y divide-border">
				{attempt.txids.map((txid) => (
					<KeyValue key={txid} label={near ? "Funding transaction" : "Transaction"}>
						<span className="flex items-center justify-end gap-1"><Mono>{shortAddress(txid, 10, 10)}</Mono><CopyButton text={txid} /></span>
					</KeyValue>
				))}
				{attempt.feeZat && <KeyValue label="Network fee"><Zec zat={attempt.feeZat} /></KeyValue>}
				{near && (
					<>
						<KeyValue label="Deposit address"><span className="flex items-center justify-end gap-1"><Mono>{shortAddress(near.quote.depositAddress)}</Mono><CopyButton text={near.quote.depositAddress} /></span></KeyValue>
						<KeyValue label="Quoted to recipient">{near.quote.amountOutFormatted} {near.quote.assetSymbol}</KeyValue>
						<KeyValue label="Provider status">{near.providerStatus ? <Badge tone={near.providerStatus === "SUCCESS" ? "success" : near.providerStatus === "REFUNDED" ? "warning" : "info"}>{near.providerStatus.replace(/_/g, " ").toLowerCase()}</Badge> : <span className="text-muted">Not checked yet</span>}</KeyValue>
						{near.destinationTxids.map((t) => (
							<KeyValue key={t} label="Delivery transaction"><span className="flex items-center justify-end gap-1"><Mono>{shortAddress(t, 10, 10)}</Mono><CopyButton text={t} /></span></KeyValue>
						))}
						{near.refundTxids.map((t) => (
							<KeyValue key={t} label="Refund transaction"><span className="flex items-center justify-end gap-1"><Mono>{shortAddress(t, 10, 10)}</Mono><CopyButton text={t} /></span></KeyValue>
						))}
						{near.checkedAt && <KeyValue label="Last checked">{formatDateTime(near.checkedAt)}</KeyValue>}
					</>
				)}
			</dl>
		</div>
	);
}

function PaymentDetail({ paymentId, initial, today, onClose }: { paymentId: string; initial: PaymentView; today: string; onClose: () => void }) {
	const { data, refresh } = useQuery("payment.get", { id: paymentId });
	const payment = data ?? initial;
	const shell = useShell();
	const toast = useToast();
	const [confirm, setConfirm] = useState<"skip" | "cancel" | null>(null);
	const { data: outstanding } = useQuery("schedules.outstanding", { id: payment.scheduleId ?? "" }, [confirm], Boolean(payment.scheduleId && confirm === "cancel"));
	const skip = useAction(async () => {
		await call("payment.skip", { id: payment.id });
		setConfirm(null);
		toast("success", "Payment skipped");
		await refresh();
	});
	const cancel = useAction(async () => {
		const result = await call("schedules.cancel", { id: payment.scheduleId! });
		setConfirm(null);
		toast("success", `Schedule cancelled${result.cancelledOccurrences ? ` · ${result.cancelledOccurrences} unpaid occurrence${result.cancelledOccurrences === 1 ? "" : "s"} cancelled` : ""}`);
		await refresh();
	});
	const recheck = useAction(async () => {
		await call("payment.recheck", { id: payment.id });
		await refresh();
	});
	const r = payment.recipient;
	const payable = ["scheduled", "draft", "failed", "refunded"].includes(payment.status);
	const blockedByUnknown = payment.attempts.some((a) => a.status === "unknown");

	return (
		<Drawer
			open
			onClose={onClose}
			title={
				<span className="flex items-center gap-2">
					{payment.scheduleId ? "Scheduled payment" : "Payment"} <PaymentStatusBadge payment={payment} today={today} />
				</span>
			}
			footer={
				<>
					{payment.status === "unknown" && (
						<Button icon={<RefreshCw className="size-4" />} loading={recheck.pending} onClick={() => recheck.run()}>Check status</Button>
					)}
					{payment.scheduleId && payment.status === "scheduled" && (
						<Button variant="ghost" icon={<SkipForward className="size-4" />} onClick={() => setConfirm("skip")}>Skip this payment</Button>
					)}
					{payable && !blockedByUnknown && (
						<Button
							variant="primary"
							icon={<Send className="size-4" />}
							onClick={() => {
								onClose();
								shell.send({ paymentId: payment.id, recipient: payment.recipient, amountZat: payment.amountZat, memo: payment.memo, note: payment.note, tags: payment.tags, scheduleId: payment.status === "scheduled" ? payment.scheduleId : null, dueDate: payment.dueDate });
							}}
						>
							{payment.status === "scheduled" ? "Review & pay" : "Send again"}
						</Button>
					)}
				</>
			}
		>
			<div className="flex flex-col items-center py-2 text-center">
				<Zec zat={payment.amountZat} className="text-[28px] font-semibold tracking-tight" />
				<div className="mt-1 text-[13px] text-muted">
					to {r.contactName ?? "address"}
					{r.route === "near-intents" && ` · paid in ${r.assetSymbol} on ${r.chain.toUpperCase()}`}
				</div>
				{payment.dueDate && <div className="mt-1 text-xs text-muted">Due {formatDate(payment.dueDate)}</div>}
			</div>
			{payment.status === "unknown" && (
				<Callout tone="warning" className="mt-4" title="Outcome not yet known">
					Zarca cannot yet tell whether this payment reached the network, so sending it again is blocked to prevent paying twice. Status is checked automatically; you can also check now.
				</Callout>
			)}
			{payment.status === "refunded" && (
				<Callout tone="warning" className="mt-4" title="Refunded — the recipient was not paid">
					The swap could not complete and the ZEC was returned to your treasury. You can send the payment again with a new quote.
				</Callout>
			)}
			{payment.status === "failed" && !blockedByUnknown && (
				<Callout tone="danger" className="mt-4" title="Not sent">
					No funds left the treasury for this payment. You can send it again after reviewing.
				</Callout>
			)}
			<Section title="Recipient">
				<dl className="divide-y divide-border rounded-xl border border-border px-3.5">
					{r.contactName && <KeyValue label="Contact">{r.contactName}</KeyValue>}
					{r.destinationLabel && <KeyValue label="Destination">{r.destinationLabel}</KeyValue>}
					<KeyValue label="Network">{r.route === "zcash" ? "Zcash" : `${r.chain.toUpperCase()} via NEAR Intents`}</KeyValue>
					{r.route === "near-intents" && <KeyValue label="Asset">{r.assetSymbol}</KeyValue>}
					<KeyValue label="Address"><span className="flex items-start justify-end gap-1"><Mono className="text-right">{r.address}</Mono><CopyButton text={r.address} /></span></KeyValue>
				</dl>
			</Section>
			{payment.memo && (
				<Section title="Recipient memo">
					<div className="rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-[13px]" data-selectable>{payment.memo}</div>
					<p className="mt-1.5 text-xs text-muted">Encrypted on-chain and visible to the recipient.</p>
				</Section>
			)}
			{(payment.feeZat || payment.valuation) && (
				<Section title="Settlement">
					<dl className="divide-y divide-border rounded-xl border border-border px-3.5">
						{payment.feeZat && <KeyValue label="Network fee"><Zec zat={payment.feeZat} /></KeyValue>}
						{payment.settledAt && <KeyValue label="Completed">{formatDateTime(payment.settledAt)}</KeyValue>}
						<KeyValue label="Recorded value"><Valuation valuation={payment.valuation} zat={payment.amountZat} /></KeyValue>
					</dl>
				</Section>
			)}
			{payment.attempts.length > 0 && (
				<Section title="Attempts">
					<div className="flex flex-col gap-2">
						{payment.attempts.map((a, i) => <AttemptRow key={a.id} attempt={a} index={i} />)}
					</div>
				</Section>
			)}
			<Section title="Bookkeeping">
				<Annotations
					note={payment.note}
					tags={payment.tags}
					onSave={async (note, tags) => {
						await call("payment.annotate", { id: payment.id, note, tags });
						await refresh();
					}}
				/>
			</Section>
			{payment.scheduleId && !["cancelled"].includes(payment.status) && (
				<Section title="Recurring schedule">
					<Button variant="ghost" className="text-danger" icon={<CalendarX className="size-4" />} onClick={() => setConfirm("cancel")}>
						Cancel recurring schedule
					</Button>
				</Section>
			)}
			<Confirm
				open={confirm === "skip"}
				onClose={() => setConfirm(null)}
				onConfirm={() => skip.run()}
				title="Skip this payment?"
				confirmLabel="Skip payment"
				pending={skip.pending}
				error={skip.error}
			>
				<p>Only the {payment.dueDate ? formatDate(payment.dueDate) : "selected"} occurrence of {r.contactName ?? "this payment"} is skipped. The recurring schedule continues.</p>
			</Confirm>
			<Confirm
				open={confirm === "cancel"}
				onClose={() => setConfirm(null)}
				onConfirm={() => cancel.run()}
				title="Cancel the recurring schedule?"
				confirmLabel="Cancel schedule"
				pending={cancel.pending}
				error={cancel.error}
			>
				<p>No further payments will be generated for this schedule.</p>
				<p>
					{outstanding?.outstanding
						? `${outstanding.outstanding} unpaid occurrence${outstanding.outstanding === 1 ? " that has" : "s that have"} not been sent will also be cancelled.`
						: "There are no unpaid occurrences outstanding."}{" "}
					Payments that were already sent are not affected and cannot be undone.
				</p>
			</Confirm>
		</Drawer>
	);
}

function ChainDetail({ item, onClose }: { item: Exclude<ActivityItem, { kind: "payment" }>; onClose: () => void }) {
	const data = item.kind === "incoming" ? item.incoming : item.external;
	const [note, setNote] = useState(data.note);
	const [tags, setTags] = useState(data.tags);
	const incoming = item.kind === "incoming" ? item.incoming : null;
	return (
		<Drawer open onClose={onClose} title={incoming ? (incoming.kind === "received" ? "Received" : incoming.kind === "refund" ? "Swap refund" : "Internal transfer") : "Sent outside Zarca"}>
			<div className="flex flex-col items-center py-2 text-center">
				<Zec zat={item.kind === "incoming" ? data.amountZat : `-${data.amountZat}`} sign className={cx("text-[28px] font-semibold tracking-tight", incoming?.kind === "received" && "text-success")} />
				<div className="mt-1 text-[13px] text-muted">{data.blockTime ? formatDateTime(data.blockTime) : "Awaiting confirmation"}</div>
			</div>
			{incoming?.kind === "refund" && (
				<p className="mt-3 text-center text-xs text-muted">ZEC returned by NEAR Intents for a cross-chain payment that did not complete. It is not counted as revenue.</p>
			)}
			{incoming?.kind === "received" && (
				<p className="mt-3 text-center text-xs text-muted">Zcash shielded payments do not reveal the sender. Add a note to record who it was from.</p>
			)}
			<Section title="Transaction">
				<dl className="divide-y divide-border rounded-xl border border-border px-3.5">
					<KeyValue label="Transaction ID"><span className="flex items-start justify-end gap-1"><Mono className="text-right">{data.txid}</Mono><CopyButton text={data.txid} /></span></KeyValue>
					<KeyValue label="Block">{data.minedHeight?.toLocaleString() ?? "Pending"}</KeyValue>
					{incoming?.confirmations !== null && incoming?.confirmations !== undefined && <KeyValue label="Confirmations"><span className="num">{incoming.confirmations.toLocaleString()}</span></KeyValue>}
					{item.kind === "external" && item.external.feeZat && <KeyValue label="Network fee"><Zec zat={item.external.feeZat} /></KeyValue>}
					<KeyValue label="Recorded value"><Valuation valuation={data.valuation} zat={data.amountZat.replace("-", "")} /></KeyValue>
				</dl>
			</Section>
			{incoming && incoming.memos.length > 0 && (
				<Section title="Memo from sender">
					{incoming.memos.map((m, i) => (
						<div key={i} className="mb-2 rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-[13px]" data-selectable>{m}</div>
					))}
				</Section>
			)}
			<Section title="Bookkeeping">
				<Annotations
					note={note}
					tags={tags}
					onSave={async (n, t) => {
						await call("tx.annotate", { txid: data.txid, note: n, tags: t });
						setNote(n);
						setTags(t);
					}}
				/>
			</Section>
		</Drawer>
	);
}
