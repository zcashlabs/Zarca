import { useMemo, useState } from "react";
import { FileSpreadsheet, Info } from "lucide-react";
import { useAction, useQuery } from "../lib/hooks";
import { call } from "../lib/rpc";
import { formatDate, formatFiat, today as localToday } from "../lib/format";
import { Button, Card, CardHeader, Checkbox, cx, Empty, ErrorText, Field, Input, Modal, Segmented, Skeleton, useToast } from "../components/ui";
import { Zec } from "../components/domain";
import { PageHeader, useShell } from "./Shell";

type Preset = "month" | "last-month" | "quarter" | "year" | "custom";

function range(preset: Preset): { from: string; to: string } {
	const now = new Date();
	const y = now.getFullYear();
	const m = now.getMonth();
	const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	switch (preset) {
		case "month": return { from: iso(new Date(y, m, 1)), to: localToday() };
		case "last-month": return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
		case "quarter": return { from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to: localToday() };
		default: return { from: iso(new Date(y, 0, 1)), to: localToday() };
	}
}

export function Reports() {
	const shell = useShell();
	const [preset, setPreset] = useState<Preset>("month");
	const [custom, setCustom] = useState(range("month"));
	const period = preset === "custom" ? custom : range(preset);
	const { data, loading, error } = useQuery("reports.get", period, [period.from, period.to]);
	const [exporting, setExporting] = useState(false);
	const currency = data?.currency ?? shell.session.walletSettings?.fiatCurrency ?? "USD";
	const money = (value: string | null) => (value === null ? "—" : formatFiat(value, currency));
	const maxTag = useMemo(() => (data?.byTag ?? []).reduce((m, t) => (BigInt(t.zat) > m ? BigInt(t.zat) : m), 0n), [data]);

	return (
		<>
			<PageHeader
				title="Reports"
				subtitle={`${formatDate(period.from)} – ${formatDate(period.to)} · values in ${currency}`}
				actions={<Button icon={<FileSpreadsheet className="size-4" />} onClick={() => setExporting(true)}>Export CSV</Button>}
			/>
			<div className="mb-5 flex flex-wrap items-end gap-3">
				<Segmented value={preset} onChange={setPreset} options={[
					{ value: "month", label: "This month" },
					{ value: "last-month", label: "Last month" },
					{ value: "quarter", label: "Quarter" },
					{ value: "year", label: "Year to date" },
					{ value: "custom", label: "Custom" },
				]} />
				{preset === "custom" && (
					<div className="flex items-center gap-2">
						<Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-9 w-40" />
						<span className="text-muted">–</span>
						<Input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-9 w-40" />
					</div>
				)}
			</div>
			{error && <ErrorText>{error}</ErrorText>}
			<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
				<Kpi label="Received" zat={data?.received.zat} fiat={data ? money(data.received.fiat) : undefined} missing={data?.received.missingRates} tone="success" />
				<Kpi label="Spent" zat={data?.spent.zat} fiat={data ? money(data.spent.fiat) : undefined} missing={data?.spent.missingRates} hint="Each payment counted once" />
				<Kpi label="Network fees" zat={data?.fees.zat} fiat={data ? money(data.fees.fiat) : undefined} missing={data?.fees.missingRates} />
			</div>
			<div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
				<Card>
					<CardHeader title="Spending by tag" subtitle="Payments can carry several tags, so tag totals overlap" />
					{loading ? (
						<div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
					) : !data?.byTag.length ? (
						<Empty title="No tagged spending in this period">Tag payments to see where funds go.</Empty>
					) : (
						<>
							<div className="flex flex-col gap-3">
								{data.byTag.map((t) => (
									<div key={t.tag}>
										<div className="mb-1 flex items-baseline justify-between text-[13px]">
											<span className="font-medium">{t.tag} <span className="text-xs font-normal text-muted">· {t.count} payment{t.count === 1 ? "" : "s"}</span></span>
											<span className="flex items-baseline gap-2"><Zec zat={t.zat} />{t.fiat && <span className="num text-xs text-muted">{money(t.fiat)}</span>}</span>
										</div>
										<div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
											<div className="h-full rounded-full bg-accent" style={{ width: `${maxTag ? Number((BigInt(t.zat) * 1000n) / maxTag) / 10 : 0}%` }} />
										</div>
									</div>
								))}
								{BigInt(data.untaggedSpent) > 0n && (
									<div className="flex items-baseline justify-between text-[13px] text-muted"><span>Untagged</span><Zec zat={data.untaggedSpent} /></div>
								)}
							</div>
							<p className="mt-4 flex items-start gap-1.5 text-xs text-muted">
								<Info className="mt-0.5 size-3.5 shrink-0" /> A payment tagged “Payroll” and “Q3” appears under both. Adding tag rows overstates spending; use the Spent total above.
							</p>
						</>
					)}
				</Card>
				<Card>
					<CardHeader title="Commitments vs. funds" subtitle="Current values" />
					{data ? (
						<dl className="flex flex-col gap-3 text-[13px]">
							<Row label="Spendable now" zat={data.spendable} extra={data.spendableFiat ? money(data.spendableFiat) : null} />
							<Row label="Overdue scheduled" zat={data.overdue} danger={BigInt(data.overdue) > 0n} />
							<Row label="Upcoming scheduled" zat={data.upcoming} />
							<div className="border-t border-border pt-3">
								<Row label="After commitments" zat={(BigInt(data.spendable) - BigInt(data.overdue) - BigInt(data.upcoming)).toString()} strong />
							</div>
						</dl>
					) : (
						<Skeleton className="h-28" />
					)}
				</Card>
			</div>
			{data && (data.received.missingRates + data.spent.missingRates + data.fees.missingRates > 0) && (
				<p className="mt-4 text-xs text-warning">Some items have no exchange rate for their date and are excluded from fiat totals. ZEC totals are complete.</p>
			)}
			<p className="mt-2 text-xs text-muted">Exchange rates: CoinGecko and Kraken public data. Completed activity keeps the rate recorded when it settled.</p>
			{exporting && <ExportCsv period={period} onClose={() => setExporting(false)} />}
		</>
	);
}

function Kpi({ label, zat, fiat, missing, tone, hint }: { label: string; zat?: string; fiat?: string; missing?: number; tone?: "success"; hint?: string }) {
	return (
		<Card>
			<div className="text-[13px] font-medium text-muted" title={hint}>{label}</div>
			{zat === undefined ? <Skeleton className="mt-2 h-7 w-36" /> : <Zec zat={zat} className={cx("mt-1.5 block text-2xl font-semibold tracking-tight", tone === "success" && BigInt(zat) > 0n && "text-success")} />}
			<div className="mt-1 h-4 text-xs text-muted">{fiat}{missing ? <span className="text-warning"> · {missing} without rate</span> : null}</div>
		</Card>
	);
}

function Row({ label, zat, extra, danger, strong }: { label: string; zat: string; extra?: string | null; danger?: boolean; strong?: boolean }) {
	return (
		<div className="flex items-baseline justify-between">
			<dt className={cx("text-muted", strong && "font-medium text-text")}>{label}</dt>
			<dd className="flex items-baseline gap-2">
				<Zec zat={zat} className={cx(danger && "text-danger", strong && "font-semibold", BigInt(zat) < 0n && "text-danger")} />
				{extra && <span className="num text-xs text-muted">{extra}</span>}
			</dd>
		</div>
	);
}

function ExportCsv({ period, onClose }: { period: { from: string; to: string }; onClose: () => void }) {
	const [from, setFrom] = useState(period.from);
	const [to, setTo] = useState(period.to);
	const [notes, setNotes] = useState(false);
	const toast = useToast();
	const run = useAction(async () => {
		const result = await call("reports.exportCsv", { from, to, includeNotes: notes });
		if (result) {
			toast("success", `Saved ${result.path.split("/").pop()}`);
			onClose();
		}
	});
	return (
		<Modal open onClose={onClose} title="Export bookkeeping CSV" subtitle="Payments, receipts, fees, statuses and recorded valuations with stable references." width={480}
			footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={run.pending} onClick={() => run.run()}>Choose folder & export</Button></>}>
			<div className="grid grid-cols-2 gap-3">
				<Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
				<Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
			</div>
			<div className="mt-4">
				<Checkbox checked={notes} onChange={setNotes}>Include private notes <span className="text-muted">(off by default — notes may contain sensitive context)</span></Checkbox>
			</div>
			<p className="mt-4 text-xs text-muted">Tags and recurring schedules are not included. Unsent scheduled occurrences are omitted.</p>
			{run.error && <div className="mt-3"><ErrorText>{run.error}</ErrorText></div>}
		</Modal>
	);
}
