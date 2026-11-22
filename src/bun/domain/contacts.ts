import type { Database } from "bun:sqlite";
import type { Contact, ContactInput, Destination, Route } from "../../shared/types";
import { cleanTags, cleanText, newId, now } from "./util";

interface ContactRow {
	id: string;
	name: string;
	photo: string | null;
	created_at: string;
	updated_at: string;
}
interface DestinationRow {
	id: string;
	contact_id: string;
	label: string;
	route: Route;
	chain: string;
	asset: string | null;
	asset_symbol: string | null;
	address: string;
	is_default: number;
}

const toDestination = (row: DestinationRow): Destination => ({
	id: row.id,
	label: row.label,
	route: row.route,
	chain: row.chain,
	asset: row.asset,
	assetSymbol: row.asset_symbol,
	address: row.address,
	isDefault: row.is_default === 1,
});

export function listContacts(db: Database): Contact[] {
	const contacts = db.query("SELECT * FROM contacts ORDER BY name COLLATE NOCASE").all() as ContactRow[];
	const destinations = db.query("SELECT * FROM destinations ORDER BY position").all() as DestinationRow[];
	const tags = db.query("SELECT contact_id, tag FROM contact_tags ORDER BY tag COLLATE NOCASE").all() as { contact_id: string; tag: string }[];
	return contacts.map((c) => ({
		id: c.id,
		name: c.name,
		photo: c.photo,
		tags: tags.filter((t) => t.contact_id === c.id).map((t) => t.tag),
		destinations: destinations.filter((d) => d.contact_id === c.id).map(toDestination),
		createdAt: c.created_at,
		updatedAt: c.updated_at,
	}));
}

export function getContact(db: Database, id: string): Contact {
	const contact = listContacts(db).find((c) => c.id === id);
	if (!contact) throw new Error("Contact not found");
	return contact;
}

const PHOTO_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export type AddressValidator = (destination: Omit<Destination, "id">) => Promise<string | null>;

/** Normalizes and validates contact input; returns an error message per destination when invalid. */
export async function validateContactInput(input: ContactInput, validate: AddressValidator): Promise<ContactInput> {
	const name = cleanText(input.name, "Name", 80, true)!;
	if (input.photo !== null && (typeof input.photo !== "string" || !PHOTO_PATTERN.test(input.photo) || input.photo.length > 400_000)) {
		throw new Error("Photo must be a PNG, JPEG or WebP image under 300 KB");
	}
	if (!Array.isArray(input.destinations) || input.destinations.length === 0) throw new Error("Add at least one payment destination");
	if (input.destinations.length > 20) throw new Error("A contact can have at most 20 destinations");
	const destinations: Omit<Destination, "id">[] = [];
	for (const [index, raw] of input.destinations.entries()) {
		const destination = {
			label: cleanText(raw.label, "Destination label", 60) ?? (raw.route === "zcash" ? "Zcash" : `${raw.assetSymbol ?? raw.chain}`),
			route: raw.route,
			chain: raw.route === "zcash" ? "zcash" : cleanText(raw.chain, "Network", 40, true)!,
			asset: raw.route === "zcash" ? null : cleanText(raw.asset, "Asset", 200, true),
			assetSymbol: raw.route === "zcash" ? "ZEC" : cleanText(raw.assetSymbol, "Asset", 20),
			address: cleanText(raw.address, "Address", 600, true)!,
			isDefault: Boolean(raw.isDefault),
		};
		if (!["zcash", "near-intents"].includes(destination.route)) throw new Error("Unknown payment route");
		const problem = await validate(destination);
		if (problem) throw new Error(`Destination ${index + 1}: ${problem}`);
		destinations.push(destination);
	}
	// Exactly one default: the first marked one, else the first Zcash destination, else the first.
	const marked = destinations.findIndex((d) => d.isDefault);
	const fallback = destinations.findIndex((d) => d.route === "zcash");
	const chosen = marked >= 0 ? marked : fallback >= 0 ? fallback : 0;
	return {
		name,
		photo: input.photo,
		tags: cleanTags(input.tags ?? []),
		destinations: destinations.map((d, i) => ({ ...d, isDefault: i === chosen })),
	};
}

function writeChildren(db: Database, id: string, input: ContactInput) {
	db.run("DELETE FROM destinations WHERE contact_id = ?", [id]);
	db.run("DELETE FROM contact_tags WHERE contact_id = ?", [id]);
	const insert = db.prepare(
		"INSERT INTO destinations (id, contact_id, label, route, chain, asset, asset_symbol, address, is_default, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	input.destinations.forEach((d, position) =>
		insert.run(newId(), id, d.label, d.route, d.chain, d.asset, d.assetSymbol, d.address, d.isDefault ? 1 : 0, position),
	);
	const tag = db.prepare("INSERT INTO contact_tags (contact_id, tag) VALUES (?, ?)");
	for (const t of input.tags) tag.run(id, t);
}

/** Input must already be validated. */
export function createContact(db: Database, input: ContactInput): string {
	const id = newId();
	const at = now();
	db.run("INSERT INTO contacts (id, name, photo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [id, input.name, input.photo, at, at]);
	writeChildren(db, id, input);
	return id;
}

/** Editing a contact never changes payments or schedules: they hold their own snapshots. */
export function updateContact(db: Database, id: string, input: ContactInput) {
	const result = db.run("UPDATE contacts SET name = ?, photo = ?, updated_at = ? WHERE id = ?", [input.name, input.photo, now(), id]);
	if (result.changes === 0) throw new Error("Contact not found");
	writeChildren(db, id, input);
}

export function deleteContact(db: Database, id: string) {
	db.run("DELETE FROM contacts WHERE id = ?", [id]);
}

// ---- Import / export ----

export const CONTACTS_FORMAT = "zarca-contacts/1";

export interface ContactExport {
	readonly format: typeof CONTACTS_FORMAT;
	readonly exportedAt: string;
	readonly contacts: readonly {
		readonly name: string;
		readonly destinations: readonly Omit<Destination, "id">[];
	}[];
}

/** Names and destinations only: photos and tags are never exported. */
export function exportContacts(db: Database): ContactExport {
	return {
		format: CONTACTS_FORMAT,
		exportedAt: now(),
		contacts: listContacts(db).map((c) => ({
			name: c.name,
			destinations: c.destinations.map(({ id: _id, ...d }) => d),
		})),
	};
}

export type ImportDecision = "skip" | "add" | "merge";
export interface ImportCandidate {
	readonly index: number;
	readonly name: string;
	readonly destinations: readonly Omit<Destination, "id">[];
	readonly status: "new" | "duplicate" | "conflict";
	readonly reasons: readonly string[];
	readonly matchContactId: string | null;
}

const destinationKey = (d: Pick<Destination, "route" | "chain" | "asset" | "address">) =>
	`${d.route}|${d.chain}|${d.asset ?? ""}|${d.address}`;

export function parseContactExport(text: string): ContactExport {
	let parsed: ContactExport;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("This file is not a Zarca contact export");
	}
	if (parsed?.format !== CONTACTS_FORMAT || !Array.isArray(parsed.contacts)) throw new Error("This file is not a Zarca contact export");
	if (parsed.contacts.length > 5000) throw new Error("Too many contacts in one file");
	return parsed;
}

/**
 * Exact duplicates (same name and same destination set) are skipped.
 * Same name with different destinations, or a destination address saved under
 * another name, is flagged for review.
 */
export function previewImport(db: Database, data: ContactExport): ImportCandidate[] {
	const existing = listContacts(db);
	const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
	const byAddress = new Map<string, Contact>();
	for (const c of existing) for (const d of c.destinations) byAddress.set(destinationKey(d), c);
	return data.contacts.map((incoming, index) => {
		const name = String(incoming.name ?? "").trim();
		const destinations = Array.isArray(incoming.destinations) ? incoming.destinations : [];
		const reasons: string[] = [];
		const same = byName.get(name.toLowerCase());
		const incomingKeys = new Set(destinations.map(destinationKey));
		if (same) {
			const sameKeys = new Set(same.destinations.map(destinationKey));
			const identical = sameKeys.size === incomingKeys.size && [...incomingKeys].every((k) => sameKeys.has(k));
			if (identical) return { index, name, destinations, status: "duplicate", reasons: [], matchContactId: same.id };
			reasons.push(`A contact named “${same.name}” already exists with different destinations`);
		}
		for (const d of destinations) {
			const owner = byAddress.get(destinationKey(d));
			if (owner && owner.name.toLowerCase() !== name.toLowerCase()) {
				reasons.push(`${d.label || d.address.slice(0, 12)} is already saved for “${owner.name}”`);
			}
		}
		return {
			index,
			name,
			destinations,
			status: reasons.length ? "conflict" : "new",
			reasons,
			matchContactId: same?.id ?? null,
		};
	});
}
