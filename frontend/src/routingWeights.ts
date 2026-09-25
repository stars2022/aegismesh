type Weights = Record<string, number>;

const TOTAL_PERCENT = 100;

function distributePercent(weights: Weights, total: number): Weights {
  const entries = Object.entries(weights);
  if (!entries.length) return {};

  const values = entries.map(([, value]) =>
    Number.isFinite(value) && value > 0 ? value : 0,
  );
  const largest = Math.max(...values);
  const ratios = values.map((value) => (largest ? value / largest : 1));
  const sum = ratios.reduce((result, value) => result + value, 0);
  const shares = entries.map(([key], index) => {
    const exact = (ratios[index] / sum) * total;
    return { key, index, percent: Math.floor(exact), remainder: exact % 1 };
  });
  const remaining = total - shares.reduce((result, share) => result + share.percent, 0);

  // Allocate rounding remainders so the visible integer percentages also add up to 100.
  const ranked = [...shares].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (let index = 0; index < remaining; index += 1) {
    ranked[index].percent += 1;
  }

  return Object.fromEntries(shares.map(({ key, percent }) => [key, percent / TOTAL_PERCENT]));
}

export function normalizeWeights(weights: Weights): Weights {
  return distributePercent(weights, TOTAL_PERCENT);
}

export function rebalanceWeights(weights: Weights, key: string, percent: number): Weights {
  const keys = Object.keys(weights);
  if (!Object.hasOwn(weights, key) || !Number.isFinite(percent) || keys.length < 2) {
    return normalizeWeights(weights);
  }

  const selected = Math.min(TOTAL_PERCENT, Math.max(0, Math.round(percent)));
  const others = Object.fromEntries(Object.entries(weights).filter(([name]) => name !== key));
  const balanced = distributePercent(others, TOTAL_PERCENT - selected);

  return Object.fromEntries(
    keys.map((name) => [name, name === key ? selected / TOTAL_PERCENT : balanced[name]]),
  );
}

export function equalizeWeights(weights: Weights): Weights {
  return normalizeWeights(Object.fromEntries(Object.keys(weights).map((key) => [key, 1])));
}
