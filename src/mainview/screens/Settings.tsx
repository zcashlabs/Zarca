import { useEffect, useRef, useState, type ReactNode } from "react";
import { HardDriveDownload, KeyRound, Laptop, Moon, Server, Sun, Trash2, Wallet } from "lucide-react";
import type { NetworkName, ThemePreference } from "../../shared/types";
import { call } from "../lib/rpc";
import { useAction, useQuery } from "../lib/hooks";
import { Badge, Button, Callout, Card, Confirm, cx, ErrorText, Field, Input, Modal, Segmented, Select, useToast } from "../components/ui";
import { PasswordInput, StrengthMeter, passwordStrength } from "../components/domain";
import { PageHeader, useShell } from "./Shell";

function SettingsSection({ id, icon, title, description, children }: { id?: string; icon: ReactNode; title: string; description?: string; children: ReactNode }) {
	return (
		<Card className="scroll-mt-6">
			<div id={id} className="grid grid-cols-1 gap-6 md:grid-cols-[240px_1fr]">
				<div>
					<div className="flex items-center gap-2 text-[15px] font-semibold">{icon}{title}</div>
					{description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
				</div>
				<div className="flex flex-col gap-4">{children}</div>
			</div>
		</Card>
	);
}

export function SettingsScreen() {
	const shell = useShell();
	const { session } = shell;
	const wallet = session.unlocked!;
	const toast = useToast();
	const walletsRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (shell.focus === "wallets") walletsRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [shell.focus]);

	const [name, setName] = useState(wallet.name);
	const rename = useAction(async () => {
		await call("wallet.rename", { walletId: wallet.id, name });
		toast("success", "Wallet renamed");
	});
	const { data: currencies } = useQuery("settings.currencies");
	const setWallet = useAction(async (patch: { fiatCurrency?: string; timezone?: string }) => {
		await call("settings.wallet", patch);
		toast("success", "Saved");
	});
	const setApp = useAction(async (patch: { theme?: ThemePreference; autoLockMinutes?: number }) => {
		await call("settings.update", patch);
		const state = await call("session.get");
		(await import("../lib/rpc")).sessionChannel.emit(state);
	});
	const [autoLock, setAutoLock] = useState(String(session.settings.autoLockMinutes));
	const [modal, setModal] = useState<"password" | "backup" | "delete" | null>(null);
	const timezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [session.walletSettings?.timezone ?? "UTC"];

	return (
		<>
			<PageHeader title="Settings" />
			<div className="flex flex-col gap-5">
				<SettingsSection icon={<Wallet className="size-4 text-accent" />} title="This wallet" description="Settings stored with this wallet's encrypted records.">
					<Field label="Wallet name" hint="Visible in the wallet picker while locked." error={rename.error}>
						<div className="flex gap-2">
							<Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
							<Button onClick={() => rename.run()} loading={rename.pending} disabled={!name.trim() || name === wallet.name}>Rename</Button>
						</div>
					</Field>
					<div className="grid grid-cols-2 gap-3">
						<Field label="Display currency" hint="Changing it keeps recorded historical valuations.">
							<Select value={session.walletSettings?.fiatCurrency} onChange={(e) => setWallet.run({ fiatCurrency: e.target.value })}>
								{(currencies ?? [session.walletSettings?.fiatCurrency ?? "USD"]).map((c) => <option key={c} value={c}>{c}</option>)}
							</Select>
						</Field>
						<Field label="Timezone" hint="Used for schedules and reports.">
							<Select value={session.walletSettings?.timezone} onChange={(e) => setWallet.run({ timezone: e.target.value })}>
								{timezones.map((t) => <option key={t} value={t}>{t}</option>)}
							</Select>
						</Field>
					</div>
					{setWallet.error && <ErrorText>{setWallet.error}</ErrorText>}
					<div className="flex flex-wrap gap-2 border-t border-border pt-4">
						<Button icon={<KeyRound className="size-4" />} onClick={() => setModal("password")}>Change password</Button>
						<Button icon={<HardDriveDownload className="size-4" />} onClick={() => setModal("backup")}>Export app-data backup</Button>
						<Button variant="ghost" className="ml-auto text-danger" icon={<Trash2 className="size-4" />} onClick={() => setModal("delete")}>Delete wallet</Button>
					</div>
				</SettingsSection>

				<SettingsSection icon={<KeyRound className="size-4 text-accent" />} title="Security" description="Applies to every wallet on this computer.">
					<Field label="Lock after inactivity" hint="The wallet also locks when the computer sleeps. Locking stops sync.">
						<div className="flex items-center gap-2">
							<Input type="number" min={1} max={240} value={autoLock} onChange={(e) => setAutoLock(e.target.value)} className="num w-24" />
							<span className="text-[13px] text-muted">minutes</span>
							<Button size="sm" disabled={Number(autoLock) === session.settings.autoLockMinutes} loading={setApp.pending} onClick={() => setApp.run({ autoLockMinutes: Number(autoLock) })}>Save</Button>
						</div>
					</Field>
					{setApp.error && <ErrorText>{setApp.error}</ErrorText>}
					<p className="text-xs text-muted">The recovery phrase is never shown again after creation. Biometric unlock is planned for macOS and Windows.</p>
				</SettingsSection>

				<SettingsSection icon={<Sun className="size-4 text-accent" />} title="Appearance">
					<Segmented<ThemePreference>
						value={session.settings.theme}
						onChange={(theme) => setApp.run({ theme })}
						options={[
							{ value: "system", label: <span className="flex items-center gap-1.5"><Laptop className="size-3.5" /> System</span> },
							{ value: "light", label: <span className="flex items-center gap-1.5"><Sun className="size-3.5" /> Light</span> },
							{ value: "dark", label: <span className="flex items-center gap-1.5"><Moon className="size-3.5" /> Dark</span> },
						]}
					/>
				</SettingsSection>

				<SettingsSection icon={<Server className="size-4 text-accent" />} title="Zcash server" description="One lightwalletd (gRPC) server per network, shared by all wallets. Zarca never switches servers automatically.">
					<ServerField network="mainnet" value={session.settings.servers.mainnet} />
					<ServerField network="testnet" value={session.settings.servers.testnet} />
				</SettingsSection>

				<div ref={walletsRef}>
					<SettingsSection icon={<Wallet className="size-4 text-accent" />} title="Wallets" description="Only one wallet is unlocked and syncing at a time. Switching locks this one.">
						<div className="divide-y divide-border rounded-xl border border-border">
							{session.wallets.map((w) => (
								<div key={w.id} className="flex items-center gap-3 px-3.5 py-2.5">
									<span className="flex-1 text-[13.5px] font-medium">{w.name}</span>
									{w.network === "testnet" && <Badge tone="warning">Testnet</Badge>}
									{w.id === wallet.id ? <Badge tone="success" dot>Unlocked</Badge> : (
										<Button size="sm" onClick={() => call("session.lock", { reason: "manual" })}>Switch</Button>
									)}
								</div>
							))}
						</div>
						<p className="text-xs text-muted">To add another wallet, lock this one and choose New wallet or Restore.</p>
					</SettingsSection>
				</div>
			</div>
			{modal === "password" && <ChangePassword onClose={() => setModal(null)} />}
			{modal === "backup" && <ExportBackup onClose={() => setModal(null)} />}
			{modal === "delete" && <DeleteWallet onClose={() => setModal(null)} />}
		</>
	);
}

function ServerField({ network, value }: { network: NetworkName; value: string }) {
	const [url, setUrl] = useState(value);
	const toast = useToast();
	const save = useAction(async () => {
		await call("settings.server", { network, url });
		toast("success", `${network === "mainnet" ? "Mainnet" : "Testnet"} server updated`);
	});
	useEffect(() => setUrl(value), [value]);
	return (
		<Field label={network === "mainnet" ? "Mainnet server" : "Testnet server"} error={save.error} hint="Format: https://host:port (lightwalletd gRPC, not a node JSON-RPC endpoint).">
			<div className="flex gap-2">
				<Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-[13px]" spellCheck={false} />
				<Button onClick={() => save.run()} loading={save.pending} disabled={url === value}>Save</Button>
			</div>
		</Field>
	);
}

function ChangePassword({ onClose }: { onClose: () => void }) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const toast = useToast();
	const run = useAction(async () => {
		await call("wallet.changePassword", { current, next });
		toast("success", "Password changed");
		onClose();
	});
	const problem = passwordStrength(next).score === 0 ? "Use at least 8 characters" : next !== confirm ? "Passwords do not match" : !current ? "Enter the current password" : null;
	return (
		<Modal open onClose={onClose} title="Change wallet password" width={440}
			footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={run.pending} disabled={Boolean(problem)} onClick={() => run.run()}>{problem ?? "Change password"}</Button></>}>
			<div className="flex flex-col gap-3">
				<Field label="Current password"><PasswordInput value={current} onChange={setCurrent} autoFocus /></Field>
				<Field label="New password"><PasswordInput value={next} onChange={setNext} autoComplete="new-password" /></Field>
				<StrengthMeter password={next} />
				<Field label="Confirm new password"><PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" /></Field>
				{run.error && <ErrorText>{run.error}</ErrorText>}
			</div>
		</Modal>
	);
}

function ExportBackup({ onClose }: { onClose: () => void }) {
	const [password, setPassword] = useState("");
	const [backupPassword, setBackupPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const toast = useToast();
	const run = useAction(async () => {
		const result = await call("backup.export", { password, backupPassword });
		if (result) {
			toast("success", `Backup saved: ${result.path.split("/").pop()}`);
			onClose();
		}
	});
	const problem = !password ? "Enter the wallet password" : passwordStrength(backupPassword).score === 0 ? "Backup password: 8+ characters" : backupPassword !== confirm ? "Backup passwords do not match" : backupPassword === password ? "Use a different backup password" : null;
	return (
		<Modal open onClose={onClose} title="Export app-data backup" width={480}
			footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={run.pending} disabled={Boolean(problem)} onClick={() => run.run()}>{problem ?? "Choose folder & export"}</Button></>}>
			<Callout tone="info" className="mb-4">
				The backup contains contacts, photos, tags, schedules and payment records. It never contains your recovery phrase or keys. To restore, you need both the recovery phrase and this file.
			</Callout>
			<div className="flex flex-col gap-3">
				<Field label="Wallet password" hint="Confirms it's you."><PasswordInput value={password} onChange={setPassword} autoFocus /></Field>
				<Field label="Backup password" hint="Separate from the wallet password. Required to restore."><PasswordInput value={backupPassword} onChange={setBackupPassword} autoComplete="new-password" /></Field>
				<StrengthMeter password={backupPassword} />
				<Field label="Confirm backup password"><PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" /></Field>
				{run.error && <ErrorText>{run.error}</ErrorText>}
			</div>
		</Modal>
	);
}

function DeleteWallet({ onClose }: { onClose: () => void }) {
	const { session } = useShell();
	const wallet = session.unlocked!;
	const [password, setPassword] = useState("");
	const [confirmName, setConfirmName] = useState("");
	const [confirming, setConfirming] = useState(false);
	const run = useAction(async () => {
		await call("wallet.delete", { walletId: wallet.id, password, confirmName });
	});
	return (
		<>
			<Modal open={!confirming} onClose={onClose} title={`Delete ${wallet.name}?`} width={460}
				footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!password || confirmName !== wallet.name} onClick={() => setConfirming(true)}>Continue</Button></>}>
				<Callout tone="danger" className="mb-4" title="This removes all local data for this wallet">
					Contacts, photos, tags, schedules, notes and payment records are deleted from this computer. Funds stay on the blockchain and can be recovered only with the recovery phrase.
				</Callout>
				<div className="flex flex-col gap-3">
					<Field label="Wallet password"><PasswordInput value={password} onChange={setPassword} autoFocus /></Field>
					<Field label={<>Type <span className="font-semibold text-text">{wallet.name}</span> to confirm</>}><Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} /></Field>
				</div>
			</Modal>
			<Confirm open={confirming} onClose={() => setConfirming(false)} onConfirm={() => run.run()} title="Permanently delete this wallet's data?" confirmLabel="Delete wallet" pending={run.pending} error={run.error}>
				<p className={cx("font-medium text-text")}>This cannot be undone.</p>
				<p>Make sure you have the recovery phrase, and an app-data backup if you want to keep the records.</p>
			</Confirm>
		</>
	);
}
