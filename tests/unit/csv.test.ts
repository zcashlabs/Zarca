import { expect, test } from "bun:test";
import { buildCsv, csvCell } from "../../src/bun/domain/csv";
import type { ActivityItem } from "../../src/shared/types";

test("cells are quoted and formula-safe", () => {
	expect(csvCell("plain")).toBe("plain");
	expect(csvCell('a "quote", here')).toBe('"a ""quote"", here"');
	expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
	expect(csvCell("-0.5", false)).toBe("-0.5");
	expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
});

test("bookkeeping rows exclude tags, unsent occurrences and notes unless asked", () => {
	const base = {
		recipient: { contactId: null, contactName: "Acme, Inc.", destinationLabel: null, route: "zcash" as const, chain: "zcash", asset: null, assetSymbol: "ZEC", address: "u1x" },
		memo: "Invoice 7", note: "secret note", tags: ["Payroll"], scheduleId: null, occurrenceDate: null, dueDate: null,
		createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
	};
	const items: ActivityItem[] = [
		{ kind: "payment", at: "2026-01-02T00:00:00Z", payment: { ...base, id: "p1", status: "completed", amountZat: "150000000", feeZat: "10000", settledAt: "2026-01-02T00:00:00Z",
			attempts: [{ id: "a", status: "confirmed", operationId: "o", txids: ["tx1"], feeZat: "10000", error: null, near: null, createdAt: "", updatedAt: "" }],
			valuation: { currency: "USD", rate: "100", source: "CoinGecko", observedAt: "2026-01-02T00:00:00Z" } } },
		{ kind: "payment", at: "2026-02-01T00:00:00Z", payment: { ...base, id: "p2", status: "scheduled", amountZat: "1", feeZat: null, settledAt: null, attempts: [], valuation: null } },
		{ kind: "incoming", at: "2026-01-01T00:00:00Z", incoming: { txid: "tx0", amountZat: "500000000", minedHeight: 10, blockTime: "2026-01-01T00:00:00Z", confirmations: 5, memos: [], note: null, tags: ["Grant"], valuation: null, kind: "received" } },
	];
	const csv = buildCsv(items, { includeNotes: false });
	const lines = csv.trim().split("\r\n");
	expect(lines).toHaveLength(3);
	expect(lines[0]).not.toContain("tag");
	expect(csv).not.toContain("Payroll");
	expect(csv).not.toContain("secret note");
	expect(lines[1]).toContain("tx:tx0");
	expect(lines[2]).toContain('"Acme, Inc."');
	expect(lines[2]).toContain("-1.50000000,-0.00010000,-1.50010000");
	expect(lines[2]).toContain("-150.01");
	expect(buildCsv(items, { includeNotes: true })).toContain("secret note");
});
