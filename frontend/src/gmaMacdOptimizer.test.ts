import { gmaMacdWorkerCount, isBetterGmaMacdShard } from "./gmaMacdOptimizer";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(gmaMacdWorkerCount(1_000, 16) === 8, "caps at 8 workers on small series");
assert(gmaMacdWorkerCount(80_000, 16) === 4, "caps at 4 workers on medium series");
assert(gmaMacdWorkerCount(250_000, 16) === 2, "caps at 2 workers on large series");
assert(gmaMacdWorkerCount(1_000, 1) === 1, "never exceeds hardware concurrency");
assert(gmaMacdWorkerCount(1_000, 0) === 1, "falls back to at least one worker");

const first = { value: 10, fi: 2, si: 4, gi: 1 };
assert(isBetterGmaMacdShard(first, null), "any shard beats empty best");
assert(
  isBetterGmaMacdShard({ value: 11, fi: 9, si: 9, gi: 9 }, first),
  "higher metric wins regardless of grid order",
);
assert(
  !isBetterGmaMacdShard({ value: 10, fi: 3, si: 0, gi: 0 }, first),
  "equal metric keeps the earlier fast index",
);
assert(
  isBetterGmaMacdShard({ value: 10, fi: 2, si: 3, gi: 9 }, first),
  "equal metric prefers earlier slow index",
);
assert(
  !isBetterGmaMacdShard({ value: 10, fi: 2, si: 4, gi: 2 }, first),
  "equal metric keeps the earlier signal index",
);

console.log("gmaMacdOptimizer tests passed");
