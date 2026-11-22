import { expect, test } from "bun:test";
import { buildReport } from "../../src/bun/domain/reports";
import type { ActivityItem, PaymentView } from "../../src/shared/types";

const payment = (id: string, amountZat: string, tags: string[], status: PaymentView["status"], extra: Partial<PaymentView> = {}): ActivityItem => ({
	kind: "payment",
	at: "2026-03-10T12:00:00Z",
	payment: {
		id, status, amountZat, tags, memo: null, note: null, scheduleId: null, occurrenceDate: null, dueDate: null,
		recipient: { contactId: null, contactName: "X", destinationLabel: null, route: "zcash", chain: "zcash", asset: null, assetSymbol: "ZEC", address: "u1" },
		attempts: [], feeZat: "10000", valuation: { currency: "USD", rate: "100", source: "t", observedAt: "" },
		createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-10T12:00:00Z", settledAt: "2026-03-10T12:00:00Z", ...extra,
	},
});

test("spending counts each payment once; tags overlap; refunds and open items are not spending", () => {
	const items: ActivityItem[] = [
		payment("a", "100000000", ["Payroll", "Q1"], "completed"),
		payment("b", "50000000", ["Payroll"], "completed"),
		payment("c", "70000000", [], "refunded", { settledAt: null }),
		payment("d", "20000000", [], "scheduled", { settledAt: null, dueDate: "2026-03-01" }),
		payment("e", "30000000", [], "scheduled", { settledAt: null, dueDate: "2026-04-01" }),
		{ kind: "incoming", at: "2026-03-05T00:00:00Z", incoming: { txid: "r", amountZat: "300000000", minedHeight: 1, blockTime: "2026-03-05T00:00:00Z", confirmations: 9, memos: [], note: null, tags: [], valuation: null, kind: "received", refundFor: null } },
		{ kind: "incoming", at: "2026-03-06T00:00:00Z", incoming: { txid: "f", amountZat: "69000000", minedHeight: 2, blockTime: "2026-03-06T00:00:00Z", confirmations: 9, memos: [], note: null, tags: [], valuation: null, kind: "refund", refundFor: "c" } },
	];
	const report = buildReport({
		items, from: "2026-03-01", to: "2026-03-31", today: "2026-03-15", timezone: "UTC", currency: "USD",
		spendableZat: 500_000_000n, currentRate: "100",
		rate: (v, at) => v?.rate ?? (at.startsWith("2026-03-05") ? "90" : null),
	});
	expect(report.spent.zat).toBe("150000000");
	expect(report.spent.fiat).toBe("150.00");
	expect(report.fees.zat).toBe("20000");
	expect(report.received.zat).toBe("300000000"); // refund excluded
	expect(report.received.fiat).toBe("270.00");
	expect(report.byTag.map((t) => [t.tag, t.zat])).toEqual([["Payroll", "150000000"], ["Q1", "100000000"]]);
	expect(report.overdue).toBe("20000000");
	expect(report.upcoming).toBe("30000000");
	expect(report.spendableFiat).toBe("500.00");
});
