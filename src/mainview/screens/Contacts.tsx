import { useMemo, useRef, useState } from "react";
import { Download, ImagePlus, Plus, Search, Send, Star, Trash2, Upload, Users } from "lucide-react";
import type { Contact, ContactInput, Destination } from "../../shared/types";
import type { ImportCandidateView } from "../../shared/api";
import { call } from "../lib/rpc";
import { useAction, useQuery } from "../lib/hooks";
import { Avatar, Badge, Button, Card, Confirm, cx, Drawer, Empty, ErrorText, Field, IconButton, Input, Modal, Segmented, Select, Skeleton, Tag, TagInput, useToast } from "../components/ui";
import { AssetSelect, AddressStatus } from "../components/RecipientPicker";
import { PageHeader, useShell } from "./Shell";

export function Contacts() {
	const { data, loading, refresh } = useQuery("contacts.list");
	const shell = useShell();
	const toast = useToast();
	const [query, setQuery] = useState("");
	const [editing, setEditing] = useState<Contact | "new" | null>(null);
	const [importing, setImporting] = useState<{ path: string; candidates: ImportCandidateView[] } | null>(null);
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (data ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)) || c.destinations.some((d) => d.address.toLowerCase().includes(q)));
	}, [data, query]);

	const exportContacts = useAction(async () => {
		const result = await call("contacts.export");
		if (result) toast("success", `Exported to ${result.path.split("/").pop()}`);
	});
	const startImport = useAction(async () => {
		const preview = await call("contacts.importPreview");
		if (preview) setImporting(preview);
	});

	return (
		<>
			<PageHeader
				title="Contacts"
				subtitle="People and organizations you pay"
				actions={
					<>
						<Button icon={<Upload className="size-4" />} onClick={() => startImport.run()} loading={startImport.pending}>Import</Button>
						<Button icon={<Download className="size-4" />} onClick={() => exportContacts.run()} loading={exportContacts.pending} disabled={!data?.length}>Export</Button>
						<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>New contact</Button>
					</>
				}
			/>
			{(startImport.error || exportContacts.error) && <div className="mb-4"><ErrorText>{startImport.error ?? exportContacts.error}</ErrorText></div>}
			<Card padded={false}>
				<div className="border-b border-border px-4 py-3">
					<div className="relative max-w-sm">
						<Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" />
						<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search contacts" className="h-9 pl-9" />
					</div>
				</div>
				{loading ? (
					<div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
				) : !filtered.length ? (
					<Empty icon={<Users className="size-5" />} title={query ? "No matching contacts" : "No contacts yet"} action={!query && <Button variant="primary" onClick={() => setEditing("new")}>Add a contact</Button>}>
						{!query && "Save recipients with one or more payment destinations, including other blockchains."}
					</Empty>
				) : (
					<div className="grid grid-cols-1 gap-px bg-border md:grid-cols-2">
						{filtered.map((c) => (
							<div key={c.id} className="group flex items-center gap-3.5 bg-surface px-4 py-3.5 transition hover:bg-surface-2/60">
								<button type="button" onClick={() => setEditing(c)} className="flex min-w-0 flex-1 items-center gap-3.5 text-left">
									<Avatar name={c.name} photo={c.photo} size={40} />
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13.5px] font-medium">{c.name}</div>
										<div className="mt-1 flex flex-wrap items-center gap-1.5">
											{c.destinations.slice(0, 3).map((d) => (
												<Badge key={d.id} tone={d.route === "zcash" ? "neutral" : "info"}>{d.route === "zcash" ? "ZEC" : `${d.assetSymbol} · ${d.chain.toUpperCase()}`}</Badge>
											))}
											{c.tags.slice(0, 2).map((t) => <Tag key={t}>{t}</Tag>)}
										</div>
									</div>
								</button>
								<IconButton label={`Pay ${c.name}`} className="opacity-0 group-hover:opacity-100" onClick={() => {
									const d = c.destinations.find((x) => x.isDefault) ?? c.destinations[0]!;
									shell.send({ recipient: { contactId: c.id, contactName: c.name, destinationLabel: d.label, route: d.route, chain: d.chain, asset: d.asset, assetSymbol: d.assetSymbol, address: d.address } });
								}}>
									<Send className="size-4" />
								</IconButton>
							</div>
						))}
					</div>
				)}
			</Card>
			{editing && <ContactEditor contact={editing === "new" ? null : editing} onClose={() => { setEditing(null); void refresh(); }} />}
			{importing && <ImportReview preview={importing} onClose={() => { setImporting(null); void refresh(); }} />}
		</>
	);
}

async function resizePhoto(file: File): Promise<string> {
	const bitmap = await createImageBitmap(file);
	const size = 160;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	const scale = Math.max(size / bitmap.width, size / bitmap.height);
	const w = bitmap.width * scale;
	const h = bitmap.height * scale;
	ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
	const webp = canvas.toDataURL("image/webp", 0.85);
	return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.85);
}

type DraftDestination = Omit<Destination, "id"> & { key: string };

function ContactEditor({ contact, onClose }: { contact: Contact | null; onClose: () => void }) {
	const shell = useShell();
	const toast = useToast();
	const network = shell.session.unlocked!.network;
	const { data: allTags } = useQuery("tags.list");
	const [name, setName] = useState(contact?.name ?? "");
	const [photo, setPhoto] = useState<string | null>(contact?.photo ?? null);
	const [tags, setTags] = useState<string[]>([...(contact?.tags ?? [])]);
	const [destinations, setDestinations] = useState<DraftDestination[]>(
		contact?.destinations.map(({ id, ...d }) => ({ ...d, key: id })) ?? [{ key: "new-0", label: "Zcash", route: "zcash", chain: "zcash", asset: null, assetSymbol: "ZEC", address: "", isDefault: true }],
	);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	const save = useAction(async () => {
		const input: ContactInput = { name, photo, tags, destinations: destinations.map(({ key: _key, ...d }) => d) };
		await call("contacts.save", { id: contact?.id ?? null, input });
		toast("success", contact ? "Contact updated" : "Contact added");
		onClose();
	});
	const remove = useAction(async () => {
		await call("contacts.delete", { id: contact!.id });
		toast("success", "Contact deleted");
		onClose();
	});
	const update = (key: string, patch: Partial<DraftDestination>) => setDestinations((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : patch.isDefault ? { ...d, isDefault: false } : d)));

	return (
		<Drawer open onClose={onClose} width={560} title={contact ? "Edit contact" : "New contact"}
			footer={
				<>
					{contact && <Button variant="ghost" className="mr-auto text-danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>Delete</Button>}
					<Button variant="ghost" onClick={onClose}>Cancel</Button>
					<Button variant="primary" loading={save.pending} disabled={!name.trim() || destinations.some((d) => !d.address.trim())} onClick={() => save.run()}>Save contact</Button>
				</>
			}>
			<div className="flex items-center gap-4">
				<button type="button" onClick={() => fileInput.current?.click()} className="group relative rounded-full" aria-label="Choose photo">
					<Avatar name={name || "?"} photo={photo} size={64} />
					<span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition group-hover:opacity-100"><ImagePlus className="size-5" /></span>
				</button>
				<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => {
					const file = e.target.files?.[0];
					if (file) setPhoto(await resizePhoto(file));
					e.target.value = "";
				}} />
				<div className="flex-1">
					<Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} /></Field>
					{photo && <button type="button" onClick={() => setPhoto(null)} className="mt-1 text-xs text-muted hover:text-text">Remove photo</button>}
				</div>
			</div>
			<div className="mt-5"><Field label="Tags"><TagInput value={tags} onChange={setTags} suggestions={allTags?.map((t) => t.tag) ?? []} /></Field></div>
			<div className="mt-6">
				<div className="mb-2 flex items-center justify-between">
					<h4 className="text-[13px] font-semibold">Payment destinations</h4>
					<div className="flex gap-1">
						<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setDestinations([...destinations, { key: `new-${Date.now()}`, label: "", route: "zcash", chain: "zcash", asset: null, assetSymbol: "ZEC", address: "", isDefault: !destinations.length }])}>Zcash</Button>
						{network === "mainnet" && (
							<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setDestinations([...destinations, { key: `new-${Date.now()}`, label: "", route: "near-intents", chain: "", asset: null, assetSymbol: null, address: "", isDefault: !destinations.length }])}>Other chain</Button>
						)}
					</div>
				</div>
				<div className="flex flex-col gap-3">
					{destinations.map((d) => (
						<div key={d.key} className="rounded-xl border border-border p-3.5">
							<div className="mb-3 flex items-center gap-2">
								<Badge tone={d.route === "zcash" ? "neutral" : "info"}>{d.route === "zcash" ? "Zcash" : "Cross-chain"}</Badge>
								<Input value={d.label} onChange={(e) => update(d.key, { label: e.target.value })} placeholder="Label (e.g. Main, Payroll USDC)" className="h-8 flex-1 text-[13px]" maxLength={60} />
								<IconButton label={d.isDefault ? "Default destination" : "Make default"} onClick={() => update(d.key, { isDefault: true })}>
									<Star className={cx("size-4", d.isDefault && "fill-accent text-accent")} />
								</IconButton>
								<IconButton label="Remove destination" onClick={() => setDestinations(destinations.filter((x) => x.key !== d.key))} disabled={destinations.length === 1}>
									<Trash2 className="size-4" />
								</IconButton>
							</div>
							{d.route === "near-intents" && (
								<div className="mb-2">
									<AssetSelect value={d.asset} onChange={(a) => update(d.key, { asset: a.assetId, assetSymbol: a.symbol, chain: a.chain })} />
								</div>
							)}
							<Input value={d.address} onChange={(e) => update(d.key, { address: e.target.value.trim() })} placeholder={d.route === "zcash" ? "Zcash address (unified preferred)" : "Recipient address on that chain"} className="font-mono text-[12.5px]" spellCheck={false} />
							{d.route === "zcash" && d.address.length > 20 && <div className="mt-1.5"><AddressStatus address={d.address} network={network} /></div>}
						</div>
					))}
				</div>
				<p className="mt-3 text-xs text-muted">Editing a contact does not change existing schedules or past payments; they keep the destination they were created with.</p>
			</div>
			{save.error && <div className="mt-4"><ErrorText>{save.error}</ErrorText></div>}
			<Confirm open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.run()} title={`Delete ${contact?.name}?`} confirmLabel="Delete contact" pending={remove.pending} error={remove.error}>
				<p>The contact is removed from this wallet. Past payments and schedules keep their recorded recipient details.</p>
			</Confirm>
		</Drawer>
	);
}

function ImportReview({ preview, onClose }: { preview: { path: string; candidates: ImportCandidateView[] }; onClose: () => void }) {
	const toast = useToast();
	const [decisions, setDecisions] = useState<Record<number, "skip" | "add" | "merge">>(() =>
		Object.fromEntries(preview.candidates.map((c) => [c.index, c.status === "new" ? "add" : "skip"])),
	);
	const apply = useAction(async () => {
		const result = await call("contacts.importApply", { path: preview.path, decisions });
		toast("success", `Imported ${result.added} new, merged ${result.merged}, skipped ${result.skipped}`);
		onClose();
	});
	const counts = { new: 0, duplicate: 0, conflict: 0 };
	for (const c of preview.candidates) counts[c.status]++;
	const [filter, setFilter] = useState<"all" | "conflict">(counts.conflict ? "conflict" : "all");
	const shown = preview.candidates.filter((c) => filter === "all" || c.status === "conflict");
	return (
		<Modal open onClose={onClose} title="Import contacts" subtitle={`${counts.new} new · ${counts.duplicate} exact duplicates skipped · ${counts.conflict} need review`} width={620}
			footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={apply.pending} onClick={() => apply.run()}>Import</Button></>}>
			{counts.conflict > 0 && (
				<Segmented className="mb-3" value={filter} onChange={setFilter} options={[{ value: "conflict", label: "Needs review", count: counts.conflict }, { value: "all", label: "All" }]} />
			)}
			<div className="divide-y divide-border rounded-xl border border-border">
				{shown.map((c) => (
					<div key={c.index} className="flex items-start gap-3 px-3.5 py-3">
						<Avatar name={c.name} size={32} />
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2 text-[13px] font-medium">
								{c.name}
								<Badge tone={c.status === "new" ? "success" : c.status === "duplicate" ? "neutral" : "warning"}>{c.status === "duplicate" ? "Duplicate" : c.status === "new" ? "New" : "Conflict"}</Badge>
							</div>
							<div className="text-xs text-muted">{c.destinationCount} destination{c.destinationCount === 1 ? "" : "s"}</div>
							{c.reasons.map((r) => <div key={r} className="mt-0.5 text-xs text-warning">{r}</div>)}
						</div>
						{c.status !== "duplicate" && (
							<Select className="h-8 w-40 text-[13px]" value={decisions[c.index]} onChange={(e) => setDecisions({ ...decisions, [c.index]: e.target.value as "skip" | "add" | "merge" })}>
								<option value="add">Add as new</option>
								{c.status === "conflict" && <option value="merge">Merge destinations</option>}
								<option value="skip">Skip</option>
							</Select>
						)}
					</div>
				))}
			</div>
			<p className="mt-3 text-xs text-muted">Contact files contain names and destinations only. Photos and tags are never exported.</p>
			{apply.error && <div className="mt-3"><ErrorText>{apply.error}</ErrorText></div>}
		</Modal>
	);
}
