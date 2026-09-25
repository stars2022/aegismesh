import assert from "node:assert/strict";
import test from "node:test";
import { equalizeWeights, normalizeWeights, rebalanceWeights } from "../src/routingWeights.ts";

const defaults = Object.freeze({
  skill: 0.34,
  reliability: 0.22,
  latency: 0.14,
  load: 0.10,
  health: 0.12,
  cost: 0.08,
});

function assertBalanced(weights) {
  const values = Object.values(weights);
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.equal(values.reduce((total, value) => total + Math.round(value * 100), 0), 100);
  assert.ok(Math.abs(values.reduce((total, value) => total + value, 0) - 1) < 1e-12);
  assert.ok(values.every((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-10));
}

test("keeps already balanced defaults and key order unchanged", () => {
  assert.deepEqual(normalizeWeights(defaults), defaults);
  assert.deepEqual(Object.keys(rebalanceWeights(defaults, "health", 43)), Object.keys(defaults));
});

test("keeps the edited weight fixed and allocates the rest proportionally", () => {
  const result = rebalanceWeights(defaults, "skill", 60);
  assert.deepEqual(result, { skill: 0.60, reliability: 0.13, latency: 0.09, load: 0.06, health: 0.07, cost: 0.05 });
  assertBalanced(result);
});

test("supports a selected weight of zero", () => {
  const result = rebalanceWeights(defaults, "skill", 0);
  assert.equal(result.skill, 0);
  assertBalanced(result);
});

test("supports a selected weight of 100 percent", () => {
  const result = rebalanceWeights(defaults, "skill", 100);
  assert.deepEqual(result, { skill: 1, reliability: 0, latency: 0, load: 0, health: 0, cost: 0 });
  assertBalanced(result);
});

test("equally distributes the remainder when all other weights are zero", () => {
  const result = rebalanceWeights({ skill: 1, reliability: 0, latency: 0, load: 0, health: 0, cost: 0 }, "skill", 50);
  assert.deepEqual(result, { skill: 0.50, reliability: 0.10, latency: 0.10, load: 0.10, health: 0.10, cost: 0.10 });
  assertBalanced(result);
});

test("preserves zero weights when positive alternatives exist", () => {
  const result = rebalanceWeights({ skill: 0.5, reliability: 0.5, cost: 0 }, "skill", 40);
  assert.deepEqual(result, { skill: 0.4, reliability: 0.6, cost: 0 });
});

test("equal distribution corrects visible rounding deterministically", () => {
  const result = equalizeWeights(defaults);
  assert.deepEqual(Object.values(result), [0.17, 0.17, 0.17, 0.17, 0.16, 0.16]);
  assertBalanced(result);
});

test("normalizes imported unbalanced or fractional weights", () => {
  assertBalanced(normalizeWeights({ skill: 0.7, reliability: 0.4, latency: 0.2 }));
  assertBalanced(normalizeWeights({ skill: 1 / 3, reliability: 1 / 3, latency: 1 / 3 }));
  assertBalanced(normalizeWeights({ skill: 0, reliability: 0, latency: 0 }));
});

test("clamps out-of-range edits and rounds to whole percent", () => {
  assert.equal(rebalanceWeights(defaults, "skill", -8).skill, 0);
  assert.equal(rebalanceWeights(defaults, "skill", 125).skill, 1);
  assert.equal(rebalanceWeights(defaults, "skill", 37.8).skill, 0.38);
});

test("handles empty, single, unknown and non-finite inputs safely", () => {
  assert.deepEqual(normalizeWeights({}), {});
  assert.deepEqual(rebalanceWeights({ skill: 1 }, "skill", 20), { skill: 1 });
  assert.deepEqual(rebalanceWeights(defaults, "unknown", 20), defaults);
  assert.deepEqual(rebalanceWeights(defaults, "skill", Number.NaN), defaults);
  assertBalanced(normalizeWeights({ skill: -1, reliability: Number.POSITIVE_INFINITY, cost: Number.NaN }));
  assertBalanced(normalizeWeights({ skill: Number.MAX_VALUE, reliability: Number.MAX_VALUE }));
});

test("does not mutate source weights", () => {
  rebalanceWeights(defaults, "latency", 80);
  equalizeWeights(defaults);
  assert.equal(defaults.skill, 0.34);
  assert.equal(defaults.latency, 0.14);
});

test("a stable gesture baseline avoids cumulative rounding drift", () => {
  for (let percent = 0; percent <= 100; percent += 1) {
    assertBalanced(rebalanceWeights(defaults, "skill", percent));
  }
  assert.deepEqual(rebalanceWeights(defaults, "skill", 34), defaults);
});

test("every integer edit of every metric remains balanced across varied policies", () => {
  const keys = Object.keys(defaults);
  for (let sample = 0; sample < 24; sample += 1) {
    const weights = Object.fromEntries(keys.map((key, index) => [key, ((sample + 3) * (index + 7)) % 31]));
    for (const key of keys) {
      for (let percent = 0; percent <= 100; percent += 1) {
        const result = rebalanceWeights(weights, key, percent);
        assertBalanced(result);
        assert.equal(Math.round(result[key] * 100), percent);
      }
    }
  }
});
