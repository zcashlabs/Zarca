import { useMemo, useState } from "react";
import { CalendarClock, CalendarX, Plus, Repeat } from "lucide-react";
import type { RecipientSnapshot, RecurrenceRule, ScheduleView, Weekday } from "../../shared/types";
import { describeRule, occurrences } from "../../shared/recurrence";
import { call } from "../lib/rpc";
import { useAction, useQuery } from "../lib/hooks";
import { addDaysLocal, formatDate, formatShortDate, parseZecInput, today as localToday } from "../lib/format";
import { Avatar, Badge, Button, Card, Confirm, cx, Empty, ErrorText, Field, Input, Modal, Select, Skeleton, TagInput, Textarea, useToast } from "../components/ui";
import { Zec } from "../components/domain";
import { RecipientPicker } from "../components/RecipientPicker";
import { useShell } from "./Shell";

export function Schedules() {
	const { data, loading, refresh } = useQuery("schedules.list");
	const [creating, setCreating] = useState(false);
	const [cancelling, setCancelling] = useState<ScheduleView | null>(null);
	const active = (data ?? []).filter((s) => !s.cancelledAt);
	const ended = (data ?? []).filter((s) => s.cancelledAt);
	return (
		<>
			<div className="mb-4 flex items-center justify-between">
				<p className="text-[13px] text-muted">Schedules prepare payments for review. Nothing is ever sent automatically.</p>
				<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New schedule</Button>
			</div>
			<Card padded={false}>
				{loading ? (
					<div className="flex flex-col gap-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
				) : !data?.length ? (
					<Empty icon={<Repeat className="size-5" />} title="No recurring payments" action={<Button variant="primary" onClick={() => setCreating(true)}>Create a schedule</Button>}>
						Set up payroll, retainers or grants. Each occurrence waits for your review and authorization.
					</Empty>
				) : (
					<div className="divide-y divide-border">
						{[...active, ...ended].map((s) => (
							<div key={s.id} className={cx("flex items-center gap-4 px-5 py-3.5", s.cancelledAt && "opacity-60")}>
								<Avatar name={s.recipient.contactName ?? s.name} size={36} />
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate text-[13.5px] font-medium">{s.name}</span>
										{s.cancelledAt ? <Badge>Cancelled</Badge> : null}
										{s.recipient.route === "near-intents" && <Badge tone="info">{s.recipient.assetSymbol}</Badge>}
									</div>
									<div className="mt-0.5 text-xs text-muted">{describeRule(s.rule)} · {s.timezone}{s.endDate ? ` · until ${formatDate(s.endDate)}` : ""}</div>
								</div>
								<div className="text-right">
									<Zec zat={s.amountZat} className="text-[13.5px] font-medium" />
									<div className="mt-0.5 text-xs text-muted">{s.nextDue ? `Next ${formatShortDate(s.nextDue)}` : s.cancelledAt ? `Ended ${formatDate(s.cancelledAt)}` : "No further dates"}</div>
								</div>
								{!s.cancelledAt && (
									<Button variant="ghost" size="sm" className="text-danger" icon={<CalendarX className="size-3.5" />} onClick={() => setCancelling(s)}>Cancel</Button>
								)}
							</div>
						))}
					</div>
				)}
			</Card>
			{creating && <ScheduleForm onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void refresh(); }} />}
			{cancelling && <CancelSchedule schedule={cancelling} onClose={() => { setCancelling(null); void refresh(); }} />}
		</>
	);
}

function CancelSchedule({ schedule, onClose }: { schedule: ScheduleView; onClose: () => void }) {
	const { data } = useQuery("schedules.outstanding", { id: schedule.id });
	const toast = useToast();
	const cancel = useAction(async () => {
		const result = await call("schedules.cancel", { id: schedule.id });
		toast("success", `Schedule cancelled${result.cancelledOccurrences ? ` · ${result.cancelledOccurrences} unpaid occurrence(s) cancelled` : ""}`);
		onClose();
	});
	return (
		<Confirm open onClose={onClose} onConfirm={() => cancel.run()} title={`Cancel “${schedule.name}”?`} confirmLabel="Cancel schedule" pending={cancel.pending} error={cancel.error}>
			<p>No further payments will be generated.</p>
			<p>
				{data?.outstanding
					? `${data.outstanding} unpaid occurrence${data.outstanding === 1 ? " that has" : "s that have"} not been sent will also be cancelled.`
					: "There are no unpaid occurrences outstanding."}{" "}
				Payments already sent are kept and cannot be undone.
			</p>
		</Confirm>
	);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type Frequency = RecurrenceRule["kind"];

function ScheduleForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
	const shell = useShell();
	const toast = useToast();
	const { data: allTags } = useQuery("tags.list");
	const [recipient, setRecipient] = useState<RecipientSnapshot | null>(null);
	const [name, setName] = useState("");
	const [amount, setAmount] = useState("");
	const [memo, setMemo] = useState("");
	const [note, setNote] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [frequency, setFrequency] = useState<Frequency>("monthly-day");
	const [interval, setInterval] = useState(1);
	const [weekdays, setWeekdays] = useState<Weekday[]>([new Date().getDay() as Weekday]);
	const [day, setDay] = useState(new Date().getDate());
	const [ordinal, setOrdinal] = useState<1 | 2 | 3 | 4 | -1>(1);
	const [weekday, setWeekday] = useState<Weekday>(5);
	const [start, setStart] = useState(localToday());
	const [end, setEnd] = useState("");

	const rule: RecurrenceRule = useMemo(() => {
		switch (frequency) {
			case "daily": return { kind: "daily", interval };
			case "weekly": return { kind: "weekly", interval, weekdays };
			case "monthly-day": return { kind: "monthly-day", interval, day };
			case "monthly-weekday": return { kind: "monthly-weekday", interval, weekday, ordinal };
		}
	}, [frequency, interval, weekdays, day, ordinal, weekday]);

	const preview = useMemo(() => {
		try {
			return occurrences(rule, start, end || null, start > localToday() ? start : localToday(), addDaysLocal(localToday(), 800), 4);
		} catch {
			return [];
		}
	}, [rule, start, end]);

	const zat = parseZecInput(amount);
	const problem = !recipient ? "Choose a recipient" : !zat || zat <= 0n ? "Enter an amount" : frequency === "weekly" && !weekdays.length ? "Choose weekdays" : end && end < start ? "End date is before start" : null;
	const create = useAction(async () => {
		await call("schedules.create", {
			name: name.trim() || null,
			recipient: recipient!,
			amountZat: zat!.toString(),
			memo: recipient!.route === "zcash" && memo.trim() ? memo : null,
			note: note.trim() || null,
			tags,
			rule,
			startDate: start,
			endDate: end || null,
		});
		toast("success", "Schedule created");
		onCreated();
	});

	return (
		<Modal open onClose={onClose} title="New recurring payment" subtitle="Each occurrence becomes a payment you review and authorize." width={600}
			footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.pending} disabled={Boolean(problem)} onClick={() => create.run()}>{problem ?? "Create schedule"}</Button></>}>
			<div className="flex flex-col gap-4">
				<Field label="Recipient">
					<RecipientPicker value={recipient} onChange={setRecipient} network={shell.session.unlocked!.network} />
				</Field>
				<div className="grid grid-cols-2 gap-3">
					<Field label="Amount per payment (ZEC)">
						<Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" className="num" inputMode="decimal" />
					</Field>
					<Field label="Name" optional>
						<Input value={name} onChange={(e) => setName(e.target.value)} placeholder={recipient?.contactName ? `${recipient.contactName} payment` : "e.g. Monthly payroll"} />
					</Field>
				</div>
				<div className="rounded-xl border border-border p-4">
					<div className="grid grid-cols-[1fr_120px] gap-3">
						<Field label="Repeats">
							<Select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
								<option value="daily">Daily</option>
								<option value="weekly">Weekly</option>
								<option value="monthly-day">Monthly on a date</option>
								<option value="monthly-weekday">Monthly on a weekday</option>
							</Select>
						</Field>
						<Field label="Every">
							<Input type="number" min={1} max={366} value={interval} onChange={(e) => setInterval(Math.max(1, Number(e.target.value) || 1))} className="num" />
						</Field>
					</div>
					{frequency === "weekly" && (
						<div className="mt-3 flex gap-1.5">
							{WEEKDAYS.map((label, i) => (
								<button key={label} type="button" onClick={() => setWeekdays(weekdays.includes(i as Weekday) ? weekdays.filter((d) => d !== i) : [...weekdays, i as Weekday])}
									className={cx("h-8 flex-1 rounded-lg text-xs font-medium transition", weekdays.includes(i as Weekday) ? "bg-accent text-accent-text" : "bg-surface-2 text-text-2 hover:bg-surface-3")}>
									{label}
								</button>
							))}
						</div>
					)}
					{frequency === "monthly-day" && (
						<div className="mt-3 w-40">
							<Field label="Day of month" hint={day > 28 ? "Uses the last day in shorter months" : undefined}>
								<Input type="number" min={1} max={31} value={day} onChange={(e) => setDay(Math.min(31, Math.max(1, Number(e.target.value) || 1)))} className="num" />
							</Field>
						</div>
					)}
					{frequency === "monthly-weekday" && (
						<div className="mt-3 grid grid-cols-2 gap-3">
							<Select value={ordinal} onChange={(e) => setOrdinal(Number(e.target.value) as typeof ordinal)}>
								<option value={1}>First</option><option value={2}>Second</option><option value={3}>Third</option><option value={4}>Fourth</option><option value={-1}>Last</option>
							</Select>
							<Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value) as Weekday)}>
								{WEEKDAYS.map((d, i) => <option key={d} value={i}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][i]}</option>)}
							</Select>
						</div>
					)}
					<div className="mt-3 grid grid-cols-2 gap-3">
						<Field label="Starts"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
						<Field label="Ends" optional><Input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></Field>
					</div>
					<div className="mt-3 flex items-center gap-2 text-xs text-muted">
						<CalendarClock className="size-3.5" />
						{describeRule(rule)} · {shell.session.walletSettings?.timezone}
					</div>
					{preview.length > 0 && (
						<div className="mt-2 flex flex-wrap gap-1.5">
							{preview.map((d) => <Badge key={d}>{formatDate(d)}</Badge>)}
						</div>
					)}
				</div>
				{recipient?.route !== "near-intents" && (
					<Field label={<span className="flex items-center gap-1.5">Recipient memo <Badge tone="info">Visible to recipient</Badge></span>} optional>
						<Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
					</Field>
				)}
				<div className="grid grid-cols-2 gap-3">
					<Field label="Tags"><TagInput value={tags} onChange={setTags} suggestions={allTags?.map((t) => t.tag) ?? []} /></Field>
					<Field label="Private note" optional><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Only on this computer" /></Field>
				</div>
				{create.error && <ErrorText>{create.error}</ErrorText>}
			</div>
		</Modal>
	);
}
