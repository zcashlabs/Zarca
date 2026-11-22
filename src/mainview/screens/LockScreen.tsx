import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, FileKey, KeyRound, Lock, Plus, ShieldCheck, Wallet } from "lucide-react";
import type { NetworkName, SessionState, WalletEntry } from "../../shared/types";
import { call } from "../lib/rpc";
import { useAction } from "../lib/hooks";
import { Badge, Button, Callout, Checkbox, cx, ErrorText, Field, Input, Segmented, Textarea } from "../components/ui";
import { PasswordInput, StrengthMeter, passwordStrength } from "../components/domain";
import { Logo } from "../components/Logo";

const LOCK_MESSAGES: Record<string, string> = {
	idle: "Locked after a period of inactivity.",
	sleep: "Locked because the computer went to sleep.",
	manual: "Wallet locked.",
	deleted: "The wallet was deleted.",
};

type View = { kind: "picker" } | { kind: "create" } | { kind: "import" };

export function LockScreen({ session }: { session: SessionState }) {
	const [view, setView] = useState<View>(session.wallets.length ? { kind: "picker" } : { kind: "picker" });
	return (
		<div className="relative flex h-full overflow-y-auto bg-bg">
			<div
				className="pointer-events-none absolute inset-0 opacity-70"
				style={{ background: "radial-gradient(1200px 600px at 50% -10%, var(--accent-soft), transparent 60%)" }}
			/>
			<div className="relative m-auto w-full max-w-[460px] px-6 py-12">
				<div className="mb-8 flex flex-col items-center text-center">
					<Logo size={44} />
					<h1 className="mt-4 text-[22px] font-semibold tracking-tight">Zarca</h1>
					<p className="mt-1 text-[13px] text-muted">Treasury for organizations on Zcash</p>
				</div>
				{view.kind === "picker" && (
					<Picker session={session} onCreate={() => setView({ kind: "create" })} onImport={() => setView({ kind: "import" })} />
				)}
				{view.kind === "create" && <CreateWallet onBack={() => setView({ kind: "picker" })} existing={session.wallets} />}
				{view.kind === "import" && <ImportWallet onBack={() => setView({ kind: "picker" })} existing={session.wallets} />}
			</div>
		</div>
	);
}

function Panel({ children }: { children: React.ReactNode }) {
	return <div className="rounded-2xl border border-border bg-surface p-6 shadow-card animate-pop">{children}</div>;
}

function Picker({ session, onCreate, onImport }: { session: SessionState; onCreate: () => void; onImport: () => void }) {
	const [selected, setSelected] = useState<string | null>(session.wallets[0]?.id ?? null);
	const [password, setPassword] = useState("");
	const unlock = useAction(async () => {
		if (!selected) return;
		await call("session.unlock", { walletId: selected, password });
	});
	useEffect(() => setPassword(""), [selected]);

	if (!session.wallets.length) {
		return (
			<Panel>
				<h2 className="text-base font-semibold">Set up your treasury</h2>
				<p className="mt-1 text-[13px] text-muted">Create a new wallet or restore one from its recovery phrase. Everything stays on this computer.</p>
				<div className="mt-5 flex flex-col gap-2.5">
					<ChoiceButton icon={<Plus className="size-4" />} title="Create a new wallet" body="Generate a new recovery phrase" onClick={onCreate} />
					<ChoiceButton icon={<FileKey className="size-4" />} title="Restore a wallet" body="From a recovery phrase, with an optional app-data backup" onClick={onImport} />
				</div>
			</Panel>
		);
	}

	const wallet = session.wallets.find((w) => w.id === selected);
	return (
		<Panel>
			{session.lockReason && LOCK_MESSAGES[session.lockReason] && (
				<div className="mb-4 flex items-center gap-2 text-[13px] text-muted">
					<Lock className="size-3.5" /> {LOCK_MESSAGES[session.lockReason]}
				</div>
			)}
			<div className="text-[13px] font-medium text-text-2">Choose a wallet</div>
			<div className="mt-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto" role="listbox">
				{session.wallets.map((w) => (
					<button
						key={w.id}
						type="button"
						role="option"
						aria-selected={w.id === selected}
						onClick={() => setSelected(w.id)}
						className={cx(
							"flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition",
							w.id === selected ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong hover:bg-surface-2",
						)}
					>
						<span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-muted"><Wallet className="size-4" /></span>
						<span className="min-w-0 flex-1 truncate text-sm font-medium">{w.name}</span>
						{w.network === "testnet" && <Badge tone="warning">Testnet</Badge>}
					</button>
				))}
			</div>
			<form
				className="mt-5 flex flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					void unlock.run();
				}}
			>
				<Field label={wallet ? `Password for ${wallet.name}` : "Password"} htmlFor="unlock-password">
					<PasswordInput id="unlock-password" value={password} onChange={setPassword} autoFocus invalid={Boolean(unlock.error)} />
				</Field>
				{unlock.error && <ErrorText>{unlock.error}</ErrorText>}
				<Button type="submit" variant="primary" size="lg" loading={unlock.pending} disabled={!password || !selected} icon={<KeyRound className="size-4" />}>
					Unlock
				</Button>
			</form>
			<div className="mt-5 flex justify-center gap-1 border-t border-border pt-4">
				<Button variant="ghost" size="sm" onClick={onCreate} icon={<Plus className="size-3.5" />}>New wallet</Button>
				<Button variant="ghost" size="sm" onClick={onImport} icon={<FileKey className="size-3.5" />}>Restore</Button>
			</div>
		</Panel>
	);
}

function ChoiceButton({ icon, title, body, onClick }: { icon: React.ReactNode; title: string; body: string; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="group flex items-center gap-3 rounded-xl border border-border px-4 py-3.5 text-left transition hover:border-accent hover:bg-accent-soft">
			<span className="flex size-9 items-center justify-center rounded-lg bg-surface-2 text-text-2 group-hover:bg-surface">{icon}</span>
			<span className="flex-1">
				<span className="block text-sm font-medium">{title}</span>
				<span className="block text-xs text-muted">{body}</span>
			</span>
			<ChevronRight className="size-4 text-muted" />
		</button>
	);
}

function StepHeader({ step, total, title, onBack, subtitle }: { step: number; total: number; title: string; onBack: () => void; subtitle?: string }) {
	return (
		<div className="mb-5">
			<div className="mb-3 flex items-center justify-between">
				<button type="button" onClick={onBack} className="-ml-1 flex items-center gap-1 rounded-md px-1 text-[13px] text-muted hover:text-text">
					<ArrowLeft className="size-3.5" /> Back
				</button>
				<span className="num text-xs text-muted">Step {step} of {total}</span>
			</div>
			<div className="mb-4 flex gap-1">
				{Array.from({ length: total }, (_, i) => (
					<span key={i} className={cx("h-1 flex-1 rounded-full", i < step ? "bg-accent" : "bg-surface-3")} />
				))}
			</div>
			<h2 className="text-base font-semibold">{title}</h2>
			{subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
		</div>
	);
}

function useDetails(existing: readonly WalletEntry[]) {
	const [name, setName] = useState("");
	const [network, setNetwork] = useState<NetworkName>("mainnet");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const nameTaken = existing.some((w) => w.name.toLowerCase() === name.trim().toLowerCase());
	const problem = !name.trim()
		? "Name the wallet"
		: nameTaken
			? "A wallet with this name exists"
			: passwordStrength(password).score === 0
				? "Use a password of at least 8 characters"
				: password !== confirm
					? "Passwords do not match"
					: null;
	const fields = (
		<div className="flex flex-col gap-4">
			<Field label="Wallet name" hint="Shown in the wallet picker, even while locked." error={nameTaken ? "A wallet with this name already exists" : null}>
				<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Operations" autoFocus maxLength={60} />
			</Field>
			<Field label="Network">
				<Segmented
					value={network}
					onChange={setNetwork}
					options={[
						{ value: "mainnet", label: "Mainnet" },
						{ value: "testnet", label: "Testnet" },
					]}
				/>
			</Field>
			<Field label="Wallet password" hint="Unlocks this wallet and authorizes each payment. It cannot be recovered.">
				<PasswordInput value={password} onChange={setPassword} autoComplete="new-password" />
			</Field>
			<StrengthMeter password={password} />
			<Field label="Confirm password" error={confirm && confirm !== password ? "Passwords do not match" : null}>
				<PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
			</Field>
		</div>
	);
	return { name, network, password, problem, fields };
}

function CreateWallet({ onBack, existing }: { onBack: () => void; existing: readonly WalletEntry[] }) {
	const details = useDetails(existing);
	const [step, setStep] = useState(1);
	const [phrase, setPhrase] = useState<{ token: string; words: string[] } | null>(null);
	const [saved, setSaved] = useState(false);
	const [answers, setAnswers] = useState<Record<number, string>>({});
	const positions = useMemo(() => {
		if (!phrase) return [];
		const picks = new Set<number>();
		const random = new Uint32Array(8);
		crypto.getRandomValues(random);
		for (const r of random) {
			if (picks.size === 3) break;
			picks.add(r % phrase.words.length);
		}
		while (picks.size < 3) picks.add(picks.size * 7);
		return [...picks].sort((a, b) => a - b);
	}, [phrase]);
	const create = useAction(async () => {
		await call("wallet.create", { token: phrase!.token, name: details.name, network: details.network, password: details.password, confirmation: answers });
	});

	useEffect(() => () => {
		if (phrase) void call("wallet.discardPhrase", { token: phrase.token }).catch(() => {});
	}, [phrase]);

	const back = () => (step === 1 ? onBack() : setStep(step - 1));

	if (step === 1) {
		return (
			<Panel>
				<StepHeader step={1} total={3} title="Create a wallet" onBack={back} />
				{details.fields}
				<Button
					className="mt-6 w-full"
					variant="primary"
					size="lg"
					disabled={Boolean(details.problem)}
					onClick={async () => {
						if (!phrase) setPhrase(await call("wallet.generatePhrase"));
						setStep(2);
					}}
				>
					{details.problem ?? "Continue"}
				</Button>
			</Panel>
		);
	}
	if (step === 2 && phrase) {
		return (
			<Panel>
				<StepHeader step={2} total={3} title="Write down your recovery phrase" onBack={back} subtitle="These 24 words are the only way to restore spending access. Zarca will never show them again." />
				<div className="grid grid-cols-3 gap-1.5 rounded-xl border border-border bg-surface-2 p-3" data-selectable>
					{phrase.words.map((word, i) => (
						<div key={i} className="flex items-baseline gap-2 rounded-lg bg-surface px-2.5 py-1.5 text-[13px] shadow-sm">
							<span className="num w-5 text-right text-[11px] text-muted">{i + 1}</span>
							<span className="font-mono font-medium">{word}</span>
						</div>
					))}
				</div>
				<Callout tone="warning" className="mt-4">
					Store it offline, somewhere only authorized people can reach. Anyone with these words can spend the treasury.
				</Callout>
				<div className="mt-4">
					<Checkbox checked={saved} onChange={setSaved}>I have written down all 24 words in order and stored them safely.</Checkbox>
				</div>
				<Button className="mt-5 w-full" variant="primary" size="lg" disabled={!saved} onClick={() => setStep(3)}>
					Continue
				</Button>
			</Panel>
		);
	}
	return (
		<Panel>
			<StepHeader step={3} total={3} title="Confirm your recovery phrase" onBack={back} subtitle="Enter the requested words to confirm your backup." />
			<form
				className="flex flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					void create.run();
				}}
			>
				{positions.map((p, i) => (
					<Field key={p} label={`Word #${p + 1}`}>
						<Input
							value={answers[p] ?? ""}
							onChange={(e) => setAnswers({ ...answers, [p]: e.target.value })}
							autoFocus={i === 0}
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
						/>
					</Field>
				))}
				{create.error && <ErrorText>{create.error}</ErrorText>}
				{create.pending && (
					<p className="text-center text-[13px] text-muted">Connecting to the network and anchoring the wallet at the current block…</p>
				)}
				<Button
					type="submit"
					className="mt-2 w-full"
					variant="primary"
					size="lg"
					loading={create.pending}
					disabled={positions.some((p) => !answers[p]?.trim())}
					icon={<ShieldCheck className="size-4" />}
				>
					Create wallet
				</Button>
			</form>
		</Panel>
	);
}

function ImportWallet({ onBack, existing }: { onBack: () => void; existing: readonly WalletEntry[] }) {
	const details = useDetails(existing);
	const [step, setStep] = useState(1);
	const [phrase, setPhrase] = useState("");
	const [createdAfter, setCreatedAfter] = useState("");
	const [backup, setBackup] = useState<string | null>(null);
	const [backupPassword, setBackupPassword] = useState("");
	const words = phrase.trim().split(/\s+/).filter(Boolean);
	const validCount = [12, 15, 18, 21, 24].includes(words.length);
	const restore = useAction(async () => {
		await call("wallet.import", {
			name: details.name,
			network: details.network,
			password: details.password,
			phrase,
			createdAfter: createdAfter || null,
			backupPath: backup,
			backupPassword: backup ? backupPassword : null,
		});
	});

	if (step === 1) {
		return (
			<Panel>
				<StepHeader step={1} total={2} title="Restore a wallet" onBack={onBack} />
				{details.fields}
				<Button className="mt-6 w-full" variant="primary" size="lg" disabled={Boolean(details.problem)} onClick={() => setStep(2)}>
					{details.problem ?? "Continue"}
				</Button>
			</Panel>
		);
	}
	return (
		<Panel>
			<StepHeader step={2} total={2} title="Recovery details" onBack={() => setStep(1)} />
			<form
				className="flex flex-col gap-4"
				onSubmit={(e) => {
					e.preventDefault();
					void restore.run();
				}}
			>
				<Field label="Recovery phrase" hint={`${words.length} words${validCount ? "" : " · 12, 15, 18, 21 or 24 expected"}`}>
					<Textarea value={phrase} onChange={(e) => setPhrase(e.target.value)} rows={4} spellCheck={false} autoComplete="off" className="font-mono text-[13px]" autoFocus />
				</Field>
				<Field label="Approximate creation date" optional hint="Scanning starts a week before this date. Leave empty to scan the whole chain (slower).">
					<Input type="date" value={createdAfter} onChange={(e) => setCreatedAfter(e.target.value)} max={new Date().toISOString().slice(0, 10)} />
				</Field>
				<Field label="App-data backup" optional hint="Restores contacts, tags, schedules and payment records. Your recovery phrase must match the backup.">
					<div className="flex items-center gap-2">
						<Button
							size="sm"
							onClick={async () => {
								const chosen = await call("files.chooseBackup");
								if (chosen) setBackup(chosen.path);
							}}
						>
							{backup ? "Change file" : "Choose backup file"}
						</Button>
						{backup && <span className="truncate text-xs text-muted">{backup.split("/").pop()}</span>}
					</div>
				</Field>
				{backup && (
					<Field label="Backup password">
						<PasswordInput value={backupPassword} onChange={setBackupPassword} autoComplete="off" />
					</Field>
				)}
				{restore.error && <ErrorText>{restore.error}</ErrorText>}
				{restore.pending && <p className="text-center text-[13px] text-muted">Restoring… history is rebuilt by syncing after the wallet opens.</p>}
				<Button type="submit" variant="primary" size="lg" loading={restore.pending} disabled={!validCount || (backup !== null && !backupPassword)}>
					Restore wallet
				</Button>
			</form>
		</Panel>
	);
}
