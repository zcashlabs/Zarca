import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, Clock, KeyRound, LockKeyhole, Pencil, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import type { PaymentView, RecipientSnapshot, SendDraft, SendReview } from "../../shared/types";
import type { SendPrefill } from "./Shell";
import { call, RpcError } from "../lib/rpc";
import { useInterval, useQuery } from "../lib/hooks";
import { fiat, formatDate, formatDateTime, formatFiat, parseZecInput, shortAddress, zatToInput } from "../lib/format";
import { Badge, Button, Callout, Confirm, cx, ErrorText, Field, Input, KeyValue, Modal, Mono, TagInput, Textarea, useToast } from "../components/ui";
import { FiatHint, PasswordInput, Zec } from "../components/domain";
import { RecipientPicker, useAddressCheck } from "../components/RecipientPicker";
import { useShell } from "./Shell";

type Step = "compose" | "review" | "done";

export function SendFlow({ prefill, onClose }: { prefill?: SendPrefill; onClose: () => void }) {
	const shell = useShell();
	const network = shell.session.unlocked!.network;
	const currency = shell.session.walletSettings?.fiatCurrency ?? "USD";
	const { data: overview } = useQuery("overview.get");
	const { data: allTags } = useQuery("tags.list");
	const rate = overview?.fiat?.rate ?? null;

	const [step, setStep] = useState<Step>("compose");
	const [recipient, setRecipient] = useState<RecipientSnapshot | null>(prefill?.recipient ?? null);
	const [amountText, setAmountText] = useState(prefill?.amountZat && prefill.amountZat !== "max" ? zatToInput(prefill.amountZat) : "");
	const [max, setMax] = useState(false);
	const [memo, setMemo] = useState(prefill?.memo ?? "");
	const [note, setNote] = useState(prefill?.note ?? "");
	const [tags, setTags] = useState<string[]>([...(prefill?.tags ?? [])]);
	const [review, setReview] = useState<SendReview | null>(null);
	const [result, setResult] = useState<PaymentView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [password, setPassword] = useState("");
	const [passwordError, setPasswordError] = useState<string | null>(null);

	const amount = max ? null : parseZecInput(amountText);
	const spendable = overview ? BigInt(overview.balance.spendable) : null;
	const isZcash = recipient?.route !== "near-intents";
	const { check } = useAddressCheck(recipient && !recipient.contactId ? recipient.address : "", recipient?.route ?? "");
	const memoAllowed = isZcash && (recipient?.contactId ? true : check?.shielded !== false);
	const memoBytes = new TextEncoder().encode(memo).length;
	const fixedTerms = Boolean(prefill?.paymentId && prefill.recipient);

	const problem = !recipient
		? "Choose a recipient"
		: !recipient.address
			? "Enter an address"
			: recipient.route === "zcash" && !recipient.contactId && check && !check.valid
				? "Invalid address"
				: !max && (amount === null || amount <= 0n)
					? "Enter an amount"
					: !max && spendable !== null && amount! > spendable
						? "Amount exceeds spendable balance"
						: memoBytes > 512
							? "Memo is too long"
							: null;

	const prepare = async () => {
		setPending(true);
		setError(null);
		try {
			const draft: SendDraft = {
				recipient: recipient!,
				amountZat: max ? "max" : amount!.toString(),
				memo: memoAllowed && memo.trim() ? memo : null,
				note: note.trim() || null,
				tags,
				...(prefill?.paymentId ? { paymentId: prefill.paymentId } : {}),
			};
			setReview(await call("send.prepare", draft));
			setPassword("");
			setPasswordError(null);
			setStep("review");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(false);
		}
	};

	const authorize = async () => {
		if (!review) return;
		setPending(true);
		setPasswordError(null);
		setError(null);
		try {
			const payment = await call("send.authorize", { reviewId: review.reviewId, password });
			setPassword("");
			setResult(payment);
			setStep("done");
		} catch (e) {
			if (e instanceof RpcError && e.code === "INCORRECT_PASSWORD") setPasswordError("Incorrect password");
			else setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(false);
		}
	};

	const close = () => {
		if (review && step === "review") void call("send.discard", { reviewId: review.reviewId }).catch(() => {});
		setPassword("");
		onClose();
	};

	const backToEdit = () => {
		if (review) void call("send.discard", { reviewId: review.reviewId }).catch(() => {});
		setReview(null);
		setPassword("");
		setStep("compose");
	};

	if (step === "done" && result) return <SendResult payment={result} onClose={onClose} />;

	const occurrenceActions = prefill?.paymentId && prefill.scheduleId ? (
		<OccurrenceActions paymentId={prefill.paymentId} scheduleId={prefill.scheduleId} dueDate={prefill.dueDate ?? null} disabled={pending} onDone={close} />
	) : null;

	if (step === "review" && review) {
		return (
			<Modal
				open
				onClose={close}
				dismissible={!pending}
				title="Review payment"
				subtitle="Check every detail. This payment cannot be reversed once sent."
				width={560}
				footer={
					<>
						<Button variant="ghost" icon={<Pencil className="size-3.5" />} onClick={backToEdit} disabled={pending}>Edit</Button>
						<Button variant="primary" icon={<KeyRound className="size-4" />} loading={pending} disabled={!password} onClick={authorize}>
							Authorize & send
						</Button>
					</>
				}
			>
				{occurrenceActions}
				<ReviewDetails review={review} currency={currency} onExpired={backToEdit} onRefresh={async () => { backToEdit(); await prepare(); }} />
				<div className="mt-5 rounded-xl border border-border bg-surface-2/60 p-4">
					<div className="mb-2 flex items-center gap-2 text-[13px] font-medium"><LockKeyhole className="size-4 text-accent" /> Authorize this payment</div>
					<PasswordInput value={password} onChange={setPassword} placeholder="Wallet password" autoFocus invalid={Boolean(passwordError)} onEnter={() => password && !pending && authorize()} />
					{passwordError ? <p className="mt-1.5 text-xs text-danger">{passwordError}</p> : <p className="mt-1.5 text-xs text-muted">Each payment is authorized separately. Your password unlocks signing for this payment only.</p>}
				</div>
				{pending && <p className="mt-3 text-center text-xs text-muted">Building, proving and sending the transaction. This can take a minute…</p>}
				{error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
			</Modal>
		);
	}

	return (
		<Modal
			open
			onClose={close}
			title={prefill?.paymentId ? "Review scheduled payment" : "Send"}
			subtitle={prefill?.paymentId ? "You can change this occurrence's amount or memo without changing the schedule." : undefined}
			width={560}
			footer={
				<>
					<Button variant="ghost" onClick={close}>Cancel</Button>
					<Button variant="primary" onClick={prepare} loading={pending} disabled={Boolean(problem)} icon={!pending ? <ArrowRight className="size-4" /> : undefined}>
						{problem ?? "Review"}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-5">
				{occurrenceActions}
				<Field label="To">
					{fixedTerms ? (
						<div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/60 px-3 py-2.5 text-sm">
							<span className="font-medium">{recipient?.contactName ?? "Address"}</span>
							<Mono className="text-muted">{shortAddress(recipient!.address)}</Mono>
							{recipient?.route === "near-intents" && <Badge tone="info">{recipient.assetSymbol} · {recipient.chain.toUpperCase()}</Badge>}
						</div>
					) : (
						<RecipientPicker value={recipient} onChange={setRecipient} network={network} />
					)}
				</Field>
				<Field
					label={recipient?.route === "near-intents" ? "Amount of ZEC to convert" : "Amount"}
					hint={
						<span className="flex justify-between">
							<span>{!max && amount ? <FiatHint zat={amount} rate={rate} currency={currency} /> : max ? "Everything spendable, minus the network fee" : " "}</span>
							{spendable !== null && <span className="num">Spendable <Zec zat={spendable} /></span>}
						</span>
					}
				>
					<Input
						value={max ? "Maximum" : amountText}
						onChange={(e) => { setMax(false); setAmountText(e.target.value.replace(/[^\d.,]/g, "")); }}
						onFocus={() => max && (setMax(false), setAmountText(""))}
						placeholder="0.00"
						inputMode="decimal"
						className="num h-12 text-lg font-semibold"
						suffix={
							<span className="flex items-center gap-1.5 pr-1">
								<span className="text-sm font-medium text-muted">ZEC</span>
								<button type="button" onClick={() => setMax(true)} className={cx("rounded-md px-2 py-1 text-xs font-semibold", max ? "bg-accent text-accent-text" : "bg-surface-2 text-text-2 hover:bg-surface-3")}>
									Max
								</button>
							</span>
						}
					/>
				</Field>
				{isZcash && (
					<Field
						label={<span className="flex items-center gap-1.5">Recipient memo <Badge tone="info">Visible to recipient</Badge></span>}
						optional
						hint={memoAllowed ? `Sent encrypted with the payment. ${memoBytes}/512 bytes.` : "Transparent addresses cannot receive memos."}
						error={memoBytes > 512 ? "Memos are limited to 512 bytes" : null}
					>
						<Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} disabled={!memoAllowed} placeholder="e.g. Invoice 2026-114" />
					</Field>
				)}
				<div className="rounded-xl border border-dashed border-border p-4">
					<div className="mb-3 flex items-center gap-1.5 text-[13px] font-medium text-text-2"><LockKeyhole className="size-3.5" /> Private bookkeeping — stays on this computer</div>
					<div className="flex flex-col gap-3">
						<Field label="Tags">
							<TagInput value={tags} onChange={setTags} suggestions={allTags?.map((t) => t.tag) ?? []} />
						</Field>
						<Field label="Note" optional>
							<Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Not visible to the recipient" />
						</Field>
					</div>
				</div>
				{error && <ErrorText>{error}</ErrorText>}
			</div>
		</Modal>
	);
}

function ReviewDetails({ review, currency, onExpired, onRefresh }: { review: SendReview; currency: string; onExpired: () => void; onRefresh: () => void }) {
	const [now, setNow] = useState(Date.now());
	useInterval(() => setNow(Date.now()), 1000);
	const expires = review.expiresAt ? Date.parse(review.expiresAt) : null;
	const remaining = expires ? Math.max(0, Math.floor((expires - now) / 1000)) : null;
	const expired = remaining === 0;
	useEffect(() => {
		if (expired && !review.near) onExpired();
	}, [expired, review.near, onExpired]);
	const r = review.recipient;
	const near = review.near;
	const rateText = review.fiat ? `${formatFiat(review.fiat.rate, review.fiat.currency)}/ZEC · ${review.fiat.source} · ${formatDateTime(review.fiat.observedAt)}${review.fiat.stale ? " (stale)" : ""}` : null;
	const total = useMemo(() => BigInt(review.totalZat), [review.totalZat]);

	return (
		<div>
			<div className="flex flex-col items-center py-1 text-center">
				<span className="text-xs font-medium uppercase tracking-wide text-muted">Total debit from treasury</span>
				<Zec zat={total} className="mt-1 text-[30px] font-semibold tracking-tight" />
				{review.fiat && <span className="num text-sm text-muted">≈ {fiat(total, review.fiat.rate, currency)}</span>}
			</div>
			<dl className="mt-4 divide-y divide-border rounded-xl border border-border px-4">
				<KeyValue label="Recipient">{r.contactName ?? "Address"}{r.destinationLabel ? <span className="text-muted"> · {r.destinationLabel}</span> : null}</KeyValue>
				<KeyValue label={r.route === "near-intents" ? `${r.chain.toUpperCase()} address` : "Zcash address"}><Mono className="text-right">{r.address}</Mono></KeyValue>
				<KeyValue label="Network & asset">{r.route === "zcash" ? "Zcash · ZEC" : <span>{r.chain.toUpperCase()} · {r.assetSymbol} <span className="text-muted">via NEAR Intents</span></span>}</KeyValue>
				<KeyValue label={near ? "ZEC converted" : "Recipient receives"}><Zec zat={review.amountZat} /></KeyValue>
				{near && (
					<>
						<KeyValue label="Recipient receives (quoted)">
							<span className="flex flex-col items-end">
								<span className="num font-semibold">{near.amountOutFormatted} {near.assetSymbol}</span>
								<span className="text-xs text-muted">At least {formatUnitsHint(near.minAmountOut, near.amountOut, near.amountOutFormatted)} {near.assetSymbol} after slippage</span>
							</span>
						</KeyValue>
						{near.feeUsd && <KeyValue label="Swap costs (est.)">≈ ${near.feeUsd}</KeyValue>}
						<KeyValue label="Deposit address"><Mono className="text-right">{near.depositAddress}</Mono></KeyValue>
						{near.timeEstimateSeconds && <KeyValue label="Estimated delivery">~{Math.ceil(near.timeEstimateSeconds / 60)} min after funding confirms</KeyValue>}
					</>
				)}
				<KeyValue label="Network fee"><Zec zat={review.feeZat} /></KeyValue>
				<KeyValue label={<span className="font-medium text-text">Total debit</span>}><Zec zat={review.totalZat} className="font-semibold" /></KeyValue>
				{review.memo && <KeyValue label="Recipient memo"><span className="whitespace-pre-wrap" data-selectable>{review.memo}</span></KeyValue>}
				{rateText && <KeyValue label="Exchange rate"><span className="text-xs text-muted">{rateText}</span></KeyValue>}
			</dl>
			{near && (
				<div className={cx("mt-3 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px]", expired ? "bg-danger-soft text-danger" : "bg-surface-2 text-text-2")}>
					<Clock className="size-4" />
					{expired ? (
						<>
							Quote expired. Terms must be refreshed and reviewed again.
							<Button size="sm" className="ml-auto" icon={<RefreshCw className="size-3.5" />} onClick={onRefresh}>Get new quote</Button>
						</>
					) : (
						<>Quote valid for <span className="num font-medium">{Math.floor(remaining! / 60)}:{String(remaining! % 60).padStart(2, "0")}</span>. Quoted {formatDateTime(near.quotedAt)}.</>
					)}
				</div>
			)}
			{near && (
				<Callout tone="info" className="mt-3">
					Funding the swap is not the same as paying the recipient: the payment stays pending until NEAR Intents confirms delivery. If the swap fails, the ZEC is refunded to this wallet.
				</Callout>
			)}
			{r.route === "zcash" && !review.memo && r.address.startsWith("t") && (
				<Callout tone="warning" className="mt-3">This is a transparent address. The amount and recipient will be publicly visible on-chain.</Callout>
			)}
		</div>
	);
}

function formatUnitsHint(min: string, out: string, outFormatted: string) {
	// Scale the formatted output by min/out without floating point drift for display.
	try {
		const ratio = Number(BigInt(min) * 1_000_000n / BigInt(out)) / 1_000_000;
		const value = Number(outFormatted) * ratio;
		return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
	} catch {
		return min;
	}
}

function SendResult({ payment, onClose }: { payment: PaymentView; onClose: () => void }) {
	const status = payment.status;
	const ok = status === "pending" || status === "completed";
	const unknown = status === "unknown";
	return (
		<Modal open onClose={onClose} width={460} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
			<div className="flex flex-col items-center py-4 text-center">
				<div className={cx("flex size-14 items-center justify-center rounded-full", ok ? "bg-success-soft text-success" : unknown ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger")}>
					{ok ? <CheckCircle2 className="size-7" /> : unknown ? <ShieldAlert className="size-7" /> : <XCircle className="size-7" />}
				</div>
				<h2 className="mt-4 text-lg font-semibold">
					{ok ? (payment.recipient.route === "near-intents" ? "Swap funded" : "Payment sent") : unknown ? "Outcome not yet known" : "Payment not sent"}
				</h2>
				<p className="mt-1.5 max-w-sm text-[13px] text-muted">
					{ok
						? payment.recipient.route === "near-intents"
							? "The ZEC deposit was broadcast. The payment completes when NEAR Intents delivers to the recipient."
							: "The transaction was broadcast. It completes after network confirmations."
						: unknown
							? "The network did not confirm whether it received the transaction. Zarca keeps checking and blocks a resend until this is resolved."
							: payment.attempts.at(-1)?.error ?? "Nothing left the treasury. You can review it and try again."}
				</p>
				<div className="mt-4"><Zec zat={payment.amountZat} className="text-xl font-semibold" /></div>
			</div>
		</Modal>
	);
}

/** Skip one occurrence or cancel its schedule, each behind an explicit confirmation screen. */
function OccurrenceActions({ paymentId, scheduleId, dueDate, disabled, onDone }: {
	paymentId: string;
	scheduleId: string;
	dueDate: string | null;
	disabled: boolean;
	onDone: () => void;
}) {
	const [confirm, setConfirm] = useState<"skip" | "cancel" | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [outstanding, setOutstanding] = useState<number | null>(null);
	const toast = useToast();
	const run = async (fn: () => Promise<string>) => {
		setPending(true);
		setError(null);
		try {
			toast("success", await fn());
			setConfirm(null);
			onDone();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(false);
		}
	};
	return (
		<div className="-mt-1 mb-1 flex items-center gap-1 rounded-xl bg-surface-2 py-1.5 pl-3.5 pr-1.5 text-[13px]">
			<span className="mr-auto whitespace-nowrap text-text-2">Due <span className="font-medium text-text">{dueDate ? formatDate(dueDate) : "—"}</span></span>
			<Button variant="ghost" size="sm" disabled={disabled} onClick={() => setConfirm("skip")}>Skip this payment</Button>
			<Button
				variant="ghost"
				size="sm"
				className="text-danger"
				disabled={disabled}
				onClick={async () => {
					setOutstanding((await call("schedules.outstanding", { id: scheduleId })).outstanding);
					setConfirm("cancel");
				}}
			>
				Cancel recurring schedule
			</Button>
			<Confirm
				open={confirm === "skip"}
				onClose={() => setConfirm(null)}
				title="Skip this payment?"
				confirmLabel="Skip payment"
				pending={pending}
				error={error}
				onConfirm={() => run(async () => {
					await call("payment.skip", { id: paymentId });
					return "Payment skipped";
				})}
			>
				<p>Only the {dueDate ? formatDate(dueDate) : "current"} occurrence is skipped. Future payments in this schedule continue.</p>
			</Confirm>
			<Confirm
				open={confirm === "cancel"}
				onClose={() => setConfirm(null)}
				title="Cancel the recurring schedule?"
				confirmLabel="Cancel schedule"
				pending={pending}
				error={error}
				onConfirm={() => run(async () => {
					const result = await call("schedules.cancel", { id: scheduleId });
					return `Schedule cancelled${result.cancelledOccurrences ? ` · ${result.cancelledOccurrences} unpaid occurrence(s) cancelled` : ""}`;
				})}
			>
				<p>No further payments will be generated, and this payment will not be sent.</p>
				<p>
					{outstanding
						? `${outstanding} unpaid occurrence${outstanding === 1 ? " (including this one) that has" : "s (including this one) that have"} not been sent will be cancelled.`
						: "There are no other unpaid occurrences."}{" "}
					Payments already sent are kept and cannot be undone.
				</p>
			</Confirm>
		</div>
	);
}
