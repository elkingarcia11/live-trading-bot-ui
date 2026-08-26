Phase 2: Scoring Functions (Distance vs. Coverage Metrics)
If you only minimize temporal or price distance, candidate strategies can easily exploit the scoring metric by either failing to take trades or opening duplicate positions. You need a multi-part loss function:

1. Temporal Distance Penalty (Entry/Exit Lag)
   For every ground-truth entry target $E_k$, measure the distance to the closest strategy signal $\hat{E}_k$:
   $$d(E_k, \hat{E}_k) = \vert{}\text{Bar Index}(E_k) - \text{Bar Index}(\hat{E}_k)\vert{}$$
   Convert distance into a bounded Proximity Score ($S_{\text{prox}}$) using an exponential decay function so large lags drop off quickly:
   $$S_{\text{prox}}(k) = \exp\left(-\frac{d(E_k, \hat{E}_k)}{\sigma}\right)$$
   (Where $\sigma$ dictates how fast the score decays as lag increases).
2. False Positive & False Negative Penalties
   To prevent strategies from firing dozens of extra signals just to land close to your labeled points, incorporate standard precision/recall components:

- False Negative (Missed Macro Move): Large penalty added if a labeled event $E_k$ has no strategy entry within the maximum window $\delta_{\text{post}}$.
- False Positive (Spurious Scalp): Penalty applied to any strategy signal $\hat{E}$ that falls completely outside all labeled target windows.
  Phase 3: The Combined Optimization Loss Function
  When using an optimization engine (e.g., Optuna, Bayesian optimization, or grid sweeps over your Pine Script / Python backtester), set your objective function to minimize Loss (or maximize Score):
  $$\text{Total Score} = \sum_{k=1}^{K} \left( w_1 \cdot S_{\text{prox}}(E_k) + w_2 \cdot S_{\text{prox}}(X_k) \right) - (w_3 \times N_{\text{false\_positives}}) - (w_4 \times N_{\text{missed\_moves}})$$

labelScoring.ts — the algorithm from Phase 2/3, written once as LABEL_SCORING_SOURCE (a raw JS string) and evaluated via new Function for main-thread use. Same string gets spliced into the Worker below, so there's one source of truth instead of two copies drifting apart.

- matchLabelsToSignals: for a label list and a signal list, builds every (label, signal) pair inside that label's [barIndex - preSignal, barIndex + lag] window, sorts by distance, and greedily assigns each label/signal at most once (deterministic tiebreak). Unmatched labels → false negatives. Signals outside every window → false positives — a duplicate signal that lands inside a window but loses the assignment race isn't penalized, which is what stops the metric from being gamed by spam-firing near a target.
- scoreLabelSet: runs that for entries and exits separately, sums proximity (exp(-d/sigma)), and combines w1*S_entry + w2*S_exit - w3*FP - w4*FN exactly as in your spec.
  gmaOptimizer.ts changes:
- score() now also records entryIndices/exitIndices — the actual bars where the simulated position opened/closed (not the raw crossover events), since that's what a ground-truth label should be judged against.
- The Worker accepts labels, labelWindow, labelWeights in the postMessage payload, and a new metric === "label_score" path calls scoreLabelSet(...) per grid candidate, using the score as the optimization objective.
- runFrontendOptimization / runMultiTimeframeOptimization take an optional labelScoring: { labels, window?, weights? } argument and thread it through.
- metricScore() and CrossTfResult know about label_score.
  One thing you'll need to do by hand: types.ts doesn't have "label_score" in the OptimizeMetric union yet, so I typed around it locally (OptimizeResultWithLabelScore). Once you share types.ts I can fold that in properly — add "label_score" to OptimizeMetric and label_score?: LabelScoreBreakdown to OptimizeResult.
  Still open for a later pass: the Phase 1 label-picker UI (click-to-select on the chart, the scrollable list below it) — that needs Chart.tsx to wire up correctly.
