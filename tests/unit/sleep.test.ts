import { expect, test } from "bun:test";
import { sleptBetween } from "../../src/bun/system/sleep";

const at = (wall: number, mono: number) => ({ wall, mono });

test("an on-time tick is not sleep", () => {
	expect(sleptBetween(at(0, 0), at(10_000, 10_000))).toBe(false);
	expect(sleptBetween(at(0, 0), at(25_000, 25_000))).toBe(false); // busy, not asleep
});

test("suspend is detected whichever clock keeps counting", () => {
	// Linux: CLOCK_MONOTONIC stops during suspend, wall time jumps.
	expect(sleptBetween(at(0, 0), at(3_600_000, 10_000))).toBe(true);
	// Windows/macOS: the monotonic clock may include the suspended time too.
	expect(sleptBetween(at(0, 0), at(3_600_000, 3_600_000))).toBe(true);
	// Wall clock set backwards while asleep: the monotonic gap still counts.
	expect(sleptBetween(at(0, 0), at(-1_000_000, 3_600_000))).toBe(true);
});
