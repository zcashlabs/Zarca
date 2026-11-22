import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, KeyRound, LockKeyhole, XCircle } from "lucide-react";
import { call, RpcError } from "../lib/rpc";
import { Button, Callout, ErrorText, KeyValue, Modal, Skeleton } from "../components/ui";
import { PasswordInput, Zec } from "../components/domain";

type Step = { pool: "transparent" | "sapling"; amountZat: string; feeZat: string };
type Result = { pool: string; txids: string[]; error: string | null };

const POOL_LABEL = { transparent: "Transparent funds (shielding)", sapling: "Sapling funds" } as const;

/** Reviews and authorizes moving older-pool funds into Ironwood (internal transfers). */
export function MigrateModal({ onClose }: { onClose: () => void }) {
	const [steps, setSteps] = useState<Step[] | null>(null);
	const [results, setResults] = useState<Result[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [password, setPassword] = useState("");
	const [passwordError, setPasswordError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	useEffect(() => {
		call("migration.prepare").then(setSteps, (e) => setError(e instanceof Error ? e.message : String(e)));
	}, []);

	const close = () => {
		if (!results) void call("migration.cancel").catch(() => {});
		onClose();
	};

	const authorize = async () => {
		setPending(true);
		setPasswordError(null);
		try {
			setResults(await call("migration.authorize", { password }));
		} catch (e) {
			if (e instanceof RpcError && e.code === "INCORRECT_PASSWORD") setPasswordError("Incorrect password");
			else setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(false);
			setPassword("");
		}
	};

	const total = (steps ?? []).reduce((n, s) => n + BigInt(s.amountZat), 0n);
	const fees = (steps ?? []).reduce((n, s) => n + BigInt(s.feeZat), 0n);

	if (results) {
		return (
			<Modal open onClose={onClose} title="Move to Ironwood" width={480} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
				<div className="flex flex-col gap-2">
					{results.map((r) => (
						<div key={r.pool} className="flex items-start gap-2.5 rounded-xl border border-border px-3.5 py-3 text-[13px]">
							{r.error ? <XCircle className="mt-0.5 size-4 text-danger" /> : <CheckCircle2 className="mt-0.5 size-4 text-success" />}
							<div>
								<div className="font-medium">{POOL_LABEL[r.pool as Step["pool"]] ?? r.pool}</div>
								<div className="text-muted">{r.error ?? "Sent. Funds become spendable after confirmations."}</div>
							</div>
						</div>
					))}
				</div>
			</Modal>
		);
	}

	return (
		<Modal
			open
			onClose={close}
			dismissible={!pending}
			title="Move funds to Ironwood"
			subtitle="Zarca spends from Ironwood. Older funds are moved with internal transfers that only cost network fees."
			width={520}
			footer={
				<>
					<Button variant="ghost" onClick={close} disabled={pending}>Cancel</Button>
					<Button variant="primary" icon={<KeyRound className="size-4" />} loading={pending} disabled={!steps?.length || !password} onClick={authorize}>
						Authorize & move
					</Button>
				</>
			}
		>
			{error && <ErrorText>{error}</ErrorText>}
			{!steps && !error && (
				<div className="flex flex-col gap-2">
					<p className="text-[13px] text-muted">Preparing the transfers. Sync pauses briefly while this runs…</p>
					<Skeleton className="h-10" />
					<Skeleton className="h-10" />
				</div>
			)}
			{steps && steps.length === 0 && <Callout tone="info">There is nothing to move right now. Older funds may still need confirmations.</Callout>}
			{steps && steps.length > 0 && (
				<>
					<dl className="divide-y divide-border rounded-xl border border-border px-4">
						{steps.map((s) => (
							<KeyValue key={s.pool} label={POOL_LABEL[s.pool]}>
								<span className="flex flex-col items-end">
									<span className="flex items-center gap-1.5"><Zec zat={s.amountZat} /> <ArrowRight className="size-3.5 text-muted" /> Ironwood</span>
									<span className="text-xs text-muted">fee <Zec zat={s.feeZat} /></span>
								</span>
							</KeyValue>
						))}
						<KeyValue label={<span className="font-medium text-text">Arrives in Ironwood</span>}><Zec zat={total} className="font-semibold" /></KeyValue>
						<KeyValue label="Total network fees"><Zec zat={fees} /></KeyValue>
					</dl>
					<p className="mt-3 text-xs text-muted">The funds stay in this wallet. Reports count these transfers as fees only, never as spending.</p>
					<div className="mt-4 rounded-xl border border-border bg-surface-2/60 p-4">
						<div className="mb-2 flex items-center gap-2 text-[13px] font-medium"><LockKeyhole className="size-4 text-accent" /> Authorize</div>
						<PasswordInput value={password} onChange={setPassword} placeholder="Wallet password" autoFocus invalid={Boolean(passwordError)} onEnter={() => password && !pending && authorize()} />
						{passwordError && <p className="mt-1.5 text-xs text-danger">{passwordError}</p>}
					</div>
				</>
			)}
		</Modal>
	);
}
