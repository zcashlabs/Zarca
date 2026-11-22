import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ChevronDown, Globe2, Search, ShieldCheck, Shuffle, X } from "lucide-react";
import type { AssetView, Contact, RecipientSnapshot } from "../../shared/types";
import { call } from "../lib/rpc";
import { useQuery } from "../lib/hooks";
import { shortAddress } from "../lib/format";
import { Avatar, Badge, Field, Input, Select, Spinner } from "./ui";
import { QrScanner } from "./QrScanner";

type AddressCheck = { valid: boolean; shielded: boolean; transparent: boolean } | null;

export function useAddressCheck(address: string, route: string) {
	const [check, setCheck] = useState<AddressCheck>(null);
	const [checking, setChecking] = useState(false);
	useEffect(() => {
		if (route !== "zcash" || address.trim().length < 20) {
			setCheck(null);
			return;
		}
		setChecking(true);
		const id = setTimeout(async () => {
			try {
				setCheck(await call("send.checkAddress", { address: address.trim() }));
			} catch {
				setCheck(null);
			} finally {
				setChecking(false);
			}
		}, 250);
		return () => clearTimeout(id);
	}, [address, route]);
	return { check, checking };
}

export function RecipientPicker({ value, onChange, network }: {
	value: RecipientSnapshot | null;
	onChange: (r: RecipientSnapshot | null) => void;
	network: "mainnet" | "testnet";
}) {
	const { data: contacts } = useQuery("contacts.list");
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<"zcash" | "near-intents">(value?.route ?? "zcash");
	const [scan, setScan] = useState(false);
	const [uriNotice, setUriNotice] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (contacts ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q))).slice(0, 8);
	}, [contacts, query]);

	const pickContact = (contact: Contact, destinationId?: string) => {
		const destination = contact.destinations.find((d) => d.id === destinationId) ?? contact.destinations.find((d) => d.isDefault) ?? contact.destinations[0]!;
		onChange({
			contactId: contact.id,
			contactName: contact.name,
			destinationLabel: destination.label,
			route: destination.route,
			chain: destination.chain,
			asset: destination.asset,
			assetSymbol: destination.assetSymbol,
			address: destination.address,
		});
		setOpen(false);
		setQuery("");
	};

	const applyText = (text: string) => {
		const trimmed = text.trim();
		if (/^zcash:/i.test(trimmed)) {
			// ZIP-321 payment URIs land in zcash.js first (zcashlabs/Zarca#2).
			setUriNotice(true);
			return;
		}
		setUriNotice(false);
		onChange({ contactId: null, contactName: null, destinationLabel: null, route: "zcash", chain: "zcash", asset: null, assetSymbol: "ZEC", address: trimmed });
	};

	// Selected contact: show a compact card with destination switcher.
	if (value?.contactId) {
		const contact = contacts?.find((c) => c.id === value.contactId);
		return (
			<div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-sm">
				<Avatar name={value.contactName ?? "?"} photo={contact?.photo} size={36} />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium">{value.contactName}</div>
					{contact && contact.destinations.length > 1 ? (
						<select
							className="mt-0.5 max-w-full bg-transparent text-xs text-muted outline-none"
							value={contact.destinations.find((d) => d.address === value.address && d.chain === value.chain)?.id}
							onChange={(e) => pickContact(contact, e.target.value)}
						>
							{contact.destinations.map((d) => (
								<option key={d.id} value={d.id}>
									{d.label} · {d.route === "zcash" ? "Zcash" : `${d.assetSymbol} on ${d.chain.toUpperCase()}`}
								</option>
							))}
						</select>
					) : (
						<div className="truncate text-xs text-muted">{value.destinationLabel} · <span className="font-mono">{shortAddress(value.address)}</span></div>
					)}
				</div>
				{value.route === "near-intents" && <Badge tone="info"><Shuffle className="size-3" />{value.assetSymbol}</Badge>}
				<button type="button" onClick={() => onChange(null)} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" aria-label="Change recipient">
					<X className="size-4" />
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="relative">
				<Input
					ref={inputRef}
					value={value && !value.contactId && mode === "zcash" ? value.address : query}
					onChange={(e) => {
						const text = e.target.value;
						if (mode === "zcash" && /^(u1|utest1|zs1|ztestsapling1|t1|t3|tm|tex1|textest1|zcash:)/i.test(text.trim())) {
							setQuery("");
							applyText(text);
						} else {
							if (value) onChange(null);
							setQuery(text);
							setOpen(true);
						}
					}}
					onFocus={() => setOpen(true)}
					onBlur={() => setTimeout(() => setOpen(false), 150)}
					placeholder={mode === "zcash" ? "Search contacts or paste a Zcash address" : "Search contacts"}
					className="pl-9 font-[inherit]"
					spellCheck={false}
					autoComplete="off"
					suffix={
						mode === "zcash" ? (
							<button type="button" onClick={() => setScan(true)} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text" aria-label="Scan QR code">
								<Camera className="size-3.5" /> Scan
							</button>
						) : undefined
					}
				/>
				<Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" />
				{open && matches.length > 0 && !(value && mode === "zcash") && (
					<div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop animate-fade">
						{matches.map((c) => (
							<button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickContact(c)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2">
								<Avatar name={c.name} photo={c.photo} size={28} />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px] font-medium">{c.name}</span>
									<span className="block truncate text-xs text-muted">{c.destinations.length} destination{c.destinations.length === 1 ? "" : "s"}{c.tags.length ? ` · ${c.tags.join(", ")}` : ""}</span>
								</span>
							</button>
						))}
					</div>
				)}
			</div>
			{uriNotice && (
				<p className="text-xs text-warning">Payment links (zcash: URIs) are not supported yet. Paste the address instead.</p>
			)}
			{mode === "zcash" && value && !value.contactId && <AddressStatus address={value.address} network={network} />}
			{network === "mainnet" && (
				<button
					type="button"
					onClick={() => {
						const next = mode === "zcash" ? "near-intents" : "zcash";
						setMode(next);
						onChange(null);
					}}
					className="flex items-center gap-1.5 self-start text-xs font-medium text-accent-strong hover:underline"
				>
					{mode === "zcash" ? <><Globe2 className="size-3.5" /> Pay to another blockchain instead</> : <>Pay a Zcash address instead</>}
				</button>
			)}
			{mode === "near-intents" && <CrossChainFields value={value} onChange={onChange} />}
			{scan && (
				<QrScanner
					onClose={() => setScan(false)}
					onResult={(text) => {
						setScan(false);
						applyText(text);
					}}
				/>
			)}
		</div>
	);
}

export function AddressStatus({ address, network }: { address: string; network: string }) {
	const { check, checking } = useAddressCheck(address, "zcash");
	if (checking) return <span className="flex items-center gap-2 text-xs text-muted"><Spinner className="size-3" /> Checking address…</span>;
	if (!check) return null;
	if (!check.valid) return <span className="text-xs text-danger">Not a valid {network} Zcash address.</span>;
	return (
		<span className="flex items-center gap-1.5 text-xs text-muted">
			{check.shielded ? (
				<><ShieldCheck className="size-3.5 text-success" /> Shielded address · amounts and memo stay private</>
			) : (
				<>Transparent address · this payment will be publicly visible on-chain and cannot carry a memo</>
			)}
		</span>
	);
}

export function AssetSelect({ value, onChange }: { value: string | null; onChange: (asset: AssetView) => void }) {
	const { data: assets, error } = useQuery("near.assets");
	const chains = useMemo(() => [...new Set((assets ?? []).map((a) => a.chain))].sort(), [assets]);
	const selected = assets?.find((a) => a.assetId === value);
	if (error) return <p className="text-xs text-danger">{error}</p>;
	return (
		<Select value={value ?? ""} onChange={(e) => { const a = assets?.find((x) => x.assetId === e.target.value); if (a) onChange(a); }} disabled={!assets}>
			<option value="" disabled>{assets ? "Choose asset and network" : "Loading assets…"}</option>
			{chains.map((chain) => (
				<optgroup key={chain} label={chain.toUpperCase()}>
					{assets!.filter((a) => a.chain === chain).map((a) => (
						<option key={a.assetId} value={a.assetId}>{a.symbol} on {chain.toUpperCase()}</option>
					))}
				</optgroup>
			))}
			{selected && !chains.includes(selected.chain) && <option value={selected.assetId}>{selected.symbol}</option>}
		</Select>
	);
}

function CrossChainFields({ value, onChange }: { value: RecipientSnapshot | null; onChange: (r: RecipientSnapshot | null) => void }) {
	const [asset, setAsset] = useState<AssetView | null>(null);
	const [address, setAddress] = useState(value?.route === "near-intents" ? value.address : "");
	useEffect(() => {
		if (asset && address.trim()) {
			onChange({ contactId: null, contactName: null, destinationLabel: null, route: "near-intents", chain: asset.chain, asset: asset.assetId, assetSymbol: asset.symbol, address: address.trim() });
		} else onChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [asset, address]);
	return (
		<div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-surface-2/60 p-3.5">
			<Field label="Recipient receives">
				<AssetSelect value={asset?.assetId ?? null} onChange={setAsset} />
			</Field>
			<Field label={`Recipient ${asset ? asset.chain.toUpperCase() : ""} address`}>
				<Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Destination address" spellCheck={false} className="font-mono text-[13px]" />
			</Field>
			<p className="flex items-start gap-1.5 text-xs text-muted">
				<ChevronDown className="mt-0.5 size-3 rotate-[-90deg]" /> Routed through NEAR Intents. You send ZEC; the recipient receives the quoted amount after swap costs.
			</p>
		</div>
	);
}

