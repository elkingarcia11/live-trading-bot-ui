/**
 * Ground-truth label scoring engine.
 *
 * Implements Phase 1's data shapes and Phase 2/3's scoring math from the spec:
 *   - Temporal proximity score via exponential decay: exp(-d/sigma)
 *   - False-negative penalty: a labeled point with no strategy signal inside its window
 *   - False-positive penalty: a strategy signal that falls completely outside every window
 *   - Combined score: w1*S_entry + w2*S_exit - w3*FP - w4*FN
 *
 * WHY THE STRING-SOURCE PATTERN:
 * gmaOptimizer.ts runs its grid search inside a Web Worker built from an inline
 * `Blob`/string source (no module bundling inside the worker). To avoid maintaining
 * two copies of this algorithm — one for the main thread, one duplicated inside the
 * worker's template string — the algorithm is written ONCE as a raw JS string
 * (`LABEL_SCORING_SOURCE`) and:
 *   1. Interpolated directly into gmaOptimizer.ts's WORKER_SOURCE template.
 *   2. Evaluated once here via `new Function` to produce real, typed exports for
 *      main-thread use (tests, UI preview scoring, etc).
 * Editing the algorithm means editing this one string — both call sites stay in sync
 * by construction.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single ground-truth point on the chart (Phase 1). */
export interface GroundTruthPoint {
  /** Index into the aligned close/high/low/times arrays used by the optimizer. */
  barIndex: number;
  /** Unix epoch seconds — kept for UI correlation / persistence, unused in scoring. */
  time: number;
}

/** The full set of labeled entry/exit points for one symbol+timeframe (Phase 1). */
export interface GroundTruthLabels {
  entries: GroundTruthPoint[];
  exits: GroundTruthPoint[];
}

/** Acceptable window around a ground-truth point, in bars. */
export interface LabelWindow {
  /** How many bars BEFORE the labeled point a signal still counts. */
  preSignal: number;
  /** How many bars AFTER the labeled point a signal still counts (lag). */
  lag: number;
}

/** Weights for the combined loss/score (w1..w4) plus the proximity decay constant. */
export interface LabelScoreWeights {
  /** w1 — weight on entry proximity score. */
  entryProximity: number;
  /** w2 — weight on exit proximity score. */
  exitProximity: number;
  /** w3 — penalty per false-positive signal (outside all windows). */
  falsePositive: number;
  /** w4 — penalty per missed (false-negative) ground-truth point. */
  falseNegative: number;
  /** sigma — proximity decay constant, in bars. Larger = more forgiving of lag. */
  sigma: number;
}

export const DEFAULT_LABEL_WINDOW: LabelWindow = { preSignal: 2, lag: 5 };

export const DEFAULT_LABEL_SCORE_WEIGHTS: LabelScoreWeights = {
  entryProximity: 1,
  exitProximity: 1,
  falsePositive: 0.5,
  falseNegative: 2,
  sigma: 3,
};

/** One matched (ground-truth, signal) pair. */
export interface LabelMatch {
  labelIndex: number;
  signalIndex: number;
  distance: number;
  proximity: number;
}

/** Result of matching one label list (entries OR exits) against one signal list. */
export interface LabelMatchResult {
  matches: LabelMatch[];
  falseNegatives: number;
  falsePositives: number;
}

/** Full breakdown for a candidate strategy against a ground-truth label set. */
export interface LabelScoreBreakdown {
  entryMatches: LabelMatch[];
  exitMatches: LabelMatch[];
  entryFalseNegatives: number;
  exitFalseNegatives: number;
  falsePositives: number;
  entryProximitySum: number;
  exitProximitySum: number;
  totalScore: number;
}

// ---------------------------------------------------------------------------
// Shared raw JS source (see file header for why this exists as a string).
//
// Defines, in plain ES2017-safe JS (worker-compatible, no TS syntax):
//   computeSignalWindows(labels, window) -> [[lo, hi], ...]
//   isWithinAnyWindow(signalIndex, windows) -> boolean
//   matchLabelsToSignals(labels, signals, window, sigma) -> LabelMatchResult-shaped obj
//   scoreLabelSet(entryLabels, exitLabels, entrySignals, exitSignals, window, weights)
//     -> LabelScoreBreakdown-shaped obj
// ---------------------------------------------------------------------------

export const LABEL_SCORING_SOURCE = `
function computeSignalWindows(labels, window) {
  var out = new Array(labels.length);
  for (var i = 0; i < labels.length; i++) {
    out[i] = [labels[i].barIndex - window.preSignal, labels[i].barIndex + window.lag];
  }
  return out;
}

function isWithinAnyWindow(signalIndex, windows) {
  for (var i = 0; i < windows.length; i++) {
    if (signalIndex >= windows[i][0] && signalIndex <= windows[i][1]) return true;
  }
  return false;
}

function matchLabelsToSignals(labels, signals, window, sigma) {
  var safeSigma = sigma > 0 ? sigma : 1e-6;
  var windows = computeSignalWindows(labels, window);

  // Build every (label, signal) pair that falls inside that label's window.
  var candidates = [];
  for (var li = 0; li < labels.length; li++) {
    var lo = windows[li][0], hi = windows[li][1];
    for (var si = 0; si < signals.length; si++) {
      var s = signals[si];
      if (s >= lo && s <= hi) {
        candidates.push({ li: li, si: si, d: Math.abs(s - labels[li].barIndex) });
      }
    }
  }
  // Greedy nearest-first assignment, each label and each signal used at most once.
  // Deterministic tiebreak: distance asc, then label index asc, then signal index asc.
  candidates.sort(function (a, b) {
    return a.d - b.d || a.li - b.li || a.si - b.si;
  });

  var usedLabels = new Uint8Array(labels.length);
  var usedSignals = new Uint8Array(signals.length);
  var matches = [];
  for (var c = 0; c < candidates.length; c++) {
    var cand = candidates[c];
    if (usedLabels[cand.li] || usedSignals[cand.si]) continue;
    usedLabels[cand.li] = 1;
    usedSignals[cand.si] = 1;
    matches.push({
      labelIndex: cand.li,
      signalIndex: cand.si,
      distance: cand.d,
      proximity: Math.exp(-cand.d / safeSigma),
    });
  }

  var falseNegatives = 0;
  for (var lj = 0; lj < labels.length; lj++) if (!usedLabels[lj]) falseNegatives++;

  // False positive = signal falls OUTSIDE every window, regardless of matching outcome.
  // (A signal inside a window that lost the assignment race is not penalized — this
  // is what stops the metric from being gamed by duplicate signals near a target,
  // while still not double-crediting them.)
  var falsePositives = 0;
  for (var sj = 0; sj < signals.length; sj++) {
    if (!isWithinAnyWindow(signals[sj], windows)) falsePositives++;
  }

  return { matches: matches, falseNegatives: falseNegatives, falsePositives: falsePositives };
}

function scoreLabelSet(entryLabels, exitLabels, entrySignals, exitSignals, window, weights) {
  var entryResult = matchLabelsToSignals(entryLabels, entrySignals, window, weights.sigma);
  var exitResult = matchLabelsToSignals(exitLabels, exitSignals, window, weights.sigma);

  var entryProximitySum = 0;
  for (var i = 0; i < entryResult.matches.length; i++) entryProximitySum += entryResult.matches[i].proximity;
  var exitProximitySum = 0;
  for (var j = 0; j < exitResult.matches.length; j++) exitProximitySum += exitResult.matches[j].proximity;

  var falsePositives = entryResult.falsePositives + exitResult.falsePositives;
  var falseNegatives = entryResult.falseNegatives + exitResult.falseNegatives;

  var totalScore =
    weights.entryProximity * entryProximitySum +
    weights.exitProximity * exitProximitySum -
    weights.falsePositive * falsePositives -
    weights.falseNegative * falseNegatives;

  return {
    entryMatches: entryResult.matches,
    exitMatches: exitResult.matches,
    entryFalseNegatives: entryResult.falseNegatives,
    exitFalseNegatives: exitResult.falseNegatives,
    falsePositives: falsePositives,
    entryProximitySum: entryProximitySum,
    exitProximitySum: exitProximitySum,
    totalScore: totalScore,
  };
}
`;

// ---------------------------------------------------------------------------
// Main-thread exports, built from the exact same source string above.
// ---------------------------------------------------------------------------

interface LabelScoringModule {
  matchLabelsToSignals: (
    labels: GroundTruthPoint[],
    signals: number[],
    window: LabelWindow,
    sigma: number,
  ) => LabelMatchResult;
  scoreLabelSet: (
    entryLabels: GroundTruthPoint[],
    exitLabels: GroundTruthPoint[],
    entrySignals: number[],
    exitSignals: number[],
    window: LabelWindow,
    weights: LabelScoreWeights,
  ) => LabelScoreBreakdown;
}

const _module: Partial<LabelScoringModule> = {};
// eslint-disable-next-line no-new-func -- see file header: single source of truth
new Function(
  "exports",
  `${LABEL_SCORING_SOURCE}
   exports.matchLabelsToSignals = matchLabelsToSignals;
   exports.scoreLabelSet = scoreLabelSet;`,
)(_module);

export const matchLabelsToSignals =
  _module.matchLabelsToSignals as LabelScoringModule["matchLabelsToSignals"];
export const scoreLabelSet =
  _module.scoreLabelSet as LabelScoringModule["scoreLabelSet"];
