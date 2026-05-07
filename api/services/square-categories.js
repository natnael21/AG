/**
 * Square + category analytics — stub returns an empty dashboard shape
 * compatible with public/burnrate.html until Square is integrated.
 */
async function burnRateHandler(req, res, pool) {
  const days = Math.min(365, Math.max(1, parseInt(String(req.query.days), 10) || 30));
  const dailyArray = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dailyArray.push({
      date: d.toISOString().slice(0, 10),
      gross: 0,
      net: 0,
      count: 0,
    });
  }

  res.json({
    period: `Last ${days} days`,
    grossRevenue: 0,
    netRevenue: 0,
    squareFees: 0,
    refunds: 0,
    paymentCount: 0,
    laborRevenue: 0,
    partsRevenue: 0,
    diagnosticFees: 0,
    otherRevenue: 0,
    partsSpend: 0,
    laborCost: 0,
    netMargin: 0,
    marginPct: '0.0',
    dailyArray,
    comparison: {
      previousPeriodRevenue: 0,
      monthOverMonthPct: '0.0',
      trend: 'up',
    },
    categoryBreakdown: [],
    recentTransactions: [],
  });
}

module.exports = { burnRateHandler };
