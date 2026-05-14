const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateRebalance,
  calculateCppiAllocation,
  calculateTailRiskBudgetAllocation,
  normalizeImportedHolding,
  validateDynamicAllocationConfig,
} = require('../../app/static/app.js');

test('calculateRebalance reports final ratio including remaining cash', () => {
  const result = calculateRebalance([
    {
      name: 'High price ETF',
      current_price: 1000,
      held_quantity: 1,
      target_ratio: 100,
      buy_mode: 'qty',
    },
  ], 500);

  assert.equal(result.total_buy_amount, 0);
  assert.equal(result.budget_remaining, 500);
  assert.equal(result.total_final_value, 1000);
  assert.equal(result.total_final_with_cash, 1500);
  assert.equal(result.results[0].final_ratio_invested_only, 100);
  assert.equal(result.results[0].final_ratio.toFixed(1), '66.7');
});

test('historical VaR does not treat all-positive returns as losses', () => {
  const closes = Array.from({ length: 100 }, (_, index) => 100 + index);
  const config = {
    method: 'var_es_risk_budget',
    minRiskWeight: 0,
    maxRiskWeight: 1,
    lookbackDays: 60,
    riskMetric: 'historical_var',
    confidenceLevel: 0.95,
    riskHorizonDays: 21,
    riskBudget: 0.05,
  };

  const result = calculateTailRiskBudgetAllocation(config, closes);

  assert.equal(result.valid, false);
  assert.match(result.warnings.join(' '), /손실위험/);
});

test('CPPI zero cushion is not forced up by minimum risk weight', async () => {
  const previousDocument = global.document;
  global.document = {
    querySelectorAll: () => [],
    getElementById: id => (id === 'budget' ? { value: '1,000' } : { value: '' }),
  };

  try {
    const result = await calculateCppiAllocation({
      method: 'cppi_floor',
      minRiskWeight: 0.2,
      maxRiskWeight: 1,
      floorMode: 'current',
      floorRatio: 1,
      maxDrawdown: 0.2,
      highWaterMark: 0,
      multiplier: 3,
    });

    assert.equal(result.valid, true);
    assert.equal(result.risk_weight, 0);
    assert.equal(result.cash_weight, 1);
  } finally {
    if (previousDocument === undefined) {
      delete global.document;
    } else {
      global.document = previousDocument;
    }
  }
});

test('dynamic config rejects out-of-range imported weights', () => {
  const errors = validateDynamicAllocationConfig({
    method: 'volatility_targeting',
    minRiskWeight: -0.1,
    maxRiskWeight: 1.5,
    lookbackDays: 60,
    targetVol: 0.1,
  });

  assert.ok(errors.length >= 2);
});

test('normalizeImportedHolding rejects unsupported market', () => {
  assert.throws(
    () => normalizeImportedHolding({ market: 'JP' }, false, 0),
    /시장 값이 올바르지 않습니다/
  );
});

test('normalizeImportedHolding accepts numeric US fields safely', () => {
  const holding = normalizeImportedHolding({
    name: 'AAPL',
    ticker: 'AAPL',
    market: 'US',
    price: 123.45,
    qty: 1.25,
    ratio: 50,
    buy_mode: 'qty',
  }, false, 0);

  assert.equal(holding.price, '123.45');
  assert.equal(holding.qty, '1.25');
  assert.equal(holding.ratio, '50');
  assert.equal(holding.market, 'US');
});
