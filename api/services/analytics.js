/**
 * Burn-rate / revenue analytics.
 *
 * Replaces services/square-categories.js, which returned a hard-coded zero
 * dashboard "until Square is integrated" — so public/burnrate.html always got
 * zeros from the API and silently fell back to randomly generated demo
 * numbers, making a dead endpoint look like a working dashboard.
 *
 * Everything here is derived from repair orders that the shop has actually
 * completed, which the schema already holds:
 *   gross revenue  = repair_orders.total_final
 *   parts revenue  = ro_parts_lines.line_total     parts cost = unit_cost x qty
 *   labor revenue  = ro_labor_lines.line_total
 *   margin         = revenue - parts cost
 *
 * Square-specific figures (processing fees, refunds, per-payment records) have
 * no source in this system. Rather than reporting them as 0 — which reads as
 * "no fees" instead of "not integrated" — they are reported as null alongside
 * `paymentsIntegration: 'not_connected'`, and the page renders them as "—".
 */

const { ValidationError } = require('./errors');

/** Revenue is booked on the day the work was completed. */
const REVENUE_DATE = `COALESCE(ro.actual_completion, ro.updated_at, ro.created_at)`;

async function getBurnRate(pool, workspaceId, days) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 365);

  /* Totals for the window, and for the window immediately before it, so the
     comparison is a real period-over-period figure. */
  const totalsSql = `
    SELECT
      COALESCE(SUM(ro.total_final), 0)          AS gross_revenue,
      COUNT(*)                                  AS order_count,
      COALESCE(SUM(p.parts_total), 0)           AS parts_revenue,
      COALESCE(SUM(p.parts_cost), 0)            AS parts_spend,
      COALESCE(SUM(l.labor_total), 0)           AS labor_revenue,
      COALESCE(SUM(l.labor_hours), 0)           AS labor_hours
    FROM repair_orders ro
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(line_total), 0) AS parts_total,
             COALESCE(SUM(COALESCE(unit_cost, 0) * quantity), 0) AS parts_cost
        FROM ro_parts_lines WHERE repair_order_id = ro.id
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(line_total), 0) AS labor_total,
             COALESCE(SUM(hours), 0)      AS labor_hours
        FROM ro_labor_lines WHERE repair_order_id = ro.id
    ) l ON true
    WHERE ro.workspace_id = $1
      AND ro.status = 'completed'
      AND ${REVENUE_DATE} >= NOW() - make_interval(days => $2::int)
      AND ${REVENUE_DATE} <  NOW() - make_interval(days => $3::int)
  `;

  const [current, previous, daily, categories, recent] = await Promise.all([
    pool.query(totalsSql, [workspaceId, safeDays, 0]),
    pool.query(totalsSql, [workspaceId, safeDays * 2, safeDays]),

    /* One row per day across the whole window, including days with no work:
       generate_series keeps the chart's x-axis continuous. */
    pool.query(
      `SELECT
         d::date AS date,
         COALESCE(SUM(ro.total_final), 0) AS gross,
         COALESCE(SUM(ro.total_final), 0) - COALESCE(SUM(c.parts_cost), 0) AS net,
         COUNT(ro.id) AS count
       FROM generate_series(
              (NOW() - make_interval(days => $2::int))::date,
              NOW()::date,
              '1 day'
            ) AS d
       LEFT JOIN repair_orders ro
         ON ro.workspace_id = $1
        AND ro.status = 'completed'
        AND ${REVENUE_DATE}::date = d::date
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(COALESCE(unit_cost, 0) * quantity), 0) AS parts_cost
           FROM ro_parts_lines WHERE repair_order_id = ro.id
       ) c ON true
       GROUP BY d
       ORDER BY d`,
      [workspaceId, safeDays - 1]
    ),

    pool.query(
      `SELECT
         COALESCE(NULLIF(rpl.part_number, ''), 'Uncategorised') AS label,
         COALESCE(pt.category, 'Uncategorised')                 AS category,
         COALESCE(SUM(rpl.line_total), 0)                       AS revenue,
         COALESCE(SUM(rpl.quantity), 0)                         AS quantity
       FROM ro_parts_lines rpl
       JOIN repair_orders ro ON ro.id = rpl.repair_order_id
       LEFT JOIN parts pt ON pt.id = rpl.part_id
      WHERE ro.workspace_id = $1
        AND ro.status = 'completed'
        AND ${REVENUE_DATE} >= NOW() - make_interval(days => $2::int)
      GROUP BY 1, 2
      ORDER BY revenue DESC
      LIMIT 10`,
      [workspaceId, safeDays]
    ),

    pool.query(
      `SELECT ro.id, ro.ro_number, ro.total_final AS amount,
              ${REVENUE_DATE} AS completed_at,
              c.full_name AS customer_name
         FROM repair_orders ro
         JOIN customers c ON c.id = ro.customer_id
        WHERE ro.workspace_id = $1
          AND ro.status = 'completed'
          AND ${REVENUE_DATE} >= NOW() - make_interval(days => $2::int)
        ORDER BY ${REVENUE_DATE} DESC
        LIMIT 8`,
      [workspaceId, safeDays]
    ),
  ]);

  const cur = current.rows[0];
  const prev = previous.rows[0];

  const gross = Number(cur.gross_revenue);
  const partsSpend = Number(cur.parts_spend);
  const netMargin = gross - partsSpend;
  const prevGross = Number(prev.gross_revenue);

  const change = prevGross > 0 ? ((gross - prevGross) / prevGross) * 100 : null;

  return {
    period: `Last ${safeDays} days`,
    days: safeDays,

    grossRevenue: round(gross),
    netRevenue: round(netMargin),
    paymentCount: Number(cur.order_count),

    laborRevenue: round(Number(cur.labor_revenue)),
    partsRevenue: round(Number(cur.parts_revenue)),
    laborHours: round(Number(cur.labor_hours)),
    partsSpend: round(partsSpend),

    netMargin: round(netMargin),
    marginPct: gross > 0 ? (netMargin / gross * 100).toFixed(1) : '0.0',

    /* No payment processor is connected, so these are unknown rather than zero. */
    paymentsIntegration: 'not_connected',
    squareFees: null,
    refunds: null,

    dailyArray: daily.rows.map((r) => ({
      date: toDateString(r.date),
      gross: round(Number(r.gross)),
      net: round(Number(r.net)),
      count: Number(r.count),
    })),

    comparison: {
      previousPeriodRevenue: round(prevGross),
      changePct: change === null ? null : change.toFixed(1),
      monthOverMonthPct: change === null ? '0.0' : change.toFixed(1),
      trend: change === null ? 'flat' : (change >= 0 ? 'up' : 'down'),
    },

    categoryBreakdown: categories.rows.map((r) => ({
      label: r.label,
      category: r.category,
      revenue: round(Number(r.revenue)),
      quantity: Number(r.quantity),
      pct: gross > 0 ? (Number(r.revenue) / gross * 100).toFixed(1) : '0.0',
    })),

    recentTransactions: recent.rows.map((r) => ({
      id: r.id,
      roNumber: r.ro_number,
      customerName: r.customer_name,
      amount: round(Number(r.amount)),
      completedAt: r.completed_at,
    })),
  };
}

function round(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function toDateString(value) {
  if (value instanceof Date) {
    /* Use local date parts: toISOString() would shift the day for negative
       UTC offsets and mislabel the chart. */
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Express handler kept compatible with the previous burnRateHandler export.
 */
async function burnRateHandler(req, res, pool, workspaceId) {
  const wsId = workspaceId != null ? workspaceId : String(req.query.workspaceId || '').trim();
  if (!wsId) throw new ValidationError('workspaceId is required.');
  const data = await getBurnRate(pool, wsId, req.query.days);
  res.json(data);
}

module.exports = { getBurnRate, burnRateHandler };
