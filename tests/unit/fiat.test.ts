import { expect, test } from "bun:test";
import { defaultCurrency, fiatValue } from "../../src/bun/fiat/rates";

test("fiat values round to cents without floating point", () => {
	expect(fiatValue(100_000_000n, "775.4")).toBe("775.40");
	expect(fiatValue(1n, "775.4")).toBe("0.00");
	expect(fiatValue(123_456_789n, "706.96")).toBe("872.79");
	expect(fiatValue(-50_000_000n, "10.005")).toBe("-5.00");
	expect(fiatValue(2_100_000_000_000_000n, "122939")).toBe("2581719000000.00");
});

test("default currency follows the locale region", () => {
	expect(defaultCurrency("en-US")).toBe("USD");
	expect(defaultCurrency("de-DE")).toBe("EUR");
	expect(defaultCurrency("en-GB")).toBe("GBP");
	expect(defaultCurrency("ja-JP")).toBe("JPY");
	expect(defaultCurrency("xx")).toBe("USD");
});
