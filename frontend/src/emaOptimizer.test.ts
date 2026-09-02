import { isEmaOptimizationAbort, runEmaOptimization } from "./emaOptimizer";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

runEmaOptimization([], "ES", "1m", "total_profit_pct", 1, null, () => undefined).then(
  () => {
    throw new Error("empty bars should reject before spawning a worker");
  },
  (err) => {
    assert(err instanceof Error && err.message === "No bars to optimize", "empty bars reject before spawning a worker");
    const abort = new DOMException("Optimization cancelled", "AbortError");
    assert(isEmaOptimizationAbort(abort), "AbortError is treated as a cancel");
    assert(!isEmaOptimizationAbort(new Error("No bars to optimize")), "other errors are not cancels");
    console.log("emaOptimizer tests passed");
  },
);
