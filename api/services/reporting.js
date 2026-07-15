/**
 * Reporting & Analytics Service
 * Provides business intelligence, financial reports, and performance metrics
 */

class ReportingService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Get financial summary for a workspace
   */
  async getFinancialSummary(workspaceId, dateRange = {}) {
    const { startDate, endDate } = dateRange;

    let dateFilter = '';
    const params = [workspaceId];
    let paramCount = 2;

    if (startDate) {
      dateFilter += ` AND ro.created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      dateFilter += ` AND ro.created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    /* Parts and labor are rolled up per repair order in LATERAL subqueries.
       Joining both line tables directly produced one row per
       (parts line x labor line) pair, so every SUM over repair_orders --
       including total_revenue -- counted an RO once per pair. */
    const query = `
      SELECT
        COUNT(*) as total_repair_orders,
        COUNT(DISTINCT ro.customer_id) as unique_customers,
        COUNT(DISTINCT ro.vehicle_id) as unique_vehicles,

        -- Revenue metrics
        COALESCE(SUM(ro.total_final), 0) as total_revenue,
        COALESCE(AVG(ro.total_final), 0) as avg_repair_order_value,

        -- Parts metrics
        COALESCE(SUM(p.parts_total), 0) as parts_revenue,
        COALESCE(SUM(p.parts_qty), 0) as total_parts_used,

        -- Labor metrics
        COALESCE(SUM(l.labor_total), 0) as labor_revenue,
        COALESCE(SUM(l.labor_hours), 0) as total_labor_hours,

        -- Status breakdown
        COUNT(CASE WHEN ro.status = 'completed' THEN 1 END) as completed_orders,
        COUNT(CASE WHEN ro.status = 'open' THEN 1 END) as open_orders,
        COUNT(CASE WHEN ro.status = 'in_progress' THEN 1 END) as in_progress_orders,
        COUNT(CASE WHEN ro.status = 'cancelled' THEN 1 END) as cancelled_orders,

        -- Time metrics
        AVG(EXTRACT(EPOCH FROM (ro.actual_completion - ro.created_at))/86400) as avg_completion_days

      FROM repair_orders ro
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(line_total), 0) AS parts_total,
               COALESCE(SUM(quantity), 0)   AS parts_qty
          FROM ro_parts_lines WHERE repair_order_id = ro.id
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(line_total), 0) AS labor_total,
               COALESCE(SUM(hours), 0)      AS labor_hours
          FROM ro_labor_lines WHERE repair_order_id = ro.id
      ) l ON true
      WHERE ro.workspace_id = $1 ${dateFilter}
    `;

    const result = await this.pool.query(query, params);
    return result.rows[0] || {};
  }

  /**
   * Get technician performance metrics
   */
  async getTechnicianPerformance(workspaceId, dateRange = {}) {
    const { startDate, endDate } = dateRange;

    let dateFilter = '';
    const params = [workspaceId];
    let paramCount = 2;

    if (startDate) {
      dateFilter += ` AND ro.created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      dateFilter += ` AND ro.created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const query = `
      SELECT
        u.id,
        u.name,
        COUNT(DISTINCT ro.id) as repair_orders_completed,
        COALESCE(SUM(rll.hours), 0) as total_hours,
        COALESCE(SUM(rll.line_total), 0) as labor_revenue,
        COALESCE(AVG(rll.line_total), 0) as avg_labor_per_order,
        COUNT(DISTINCT ro.customer_id) as unique_customers_served,

        -- Time tracking
        COALESCE(SUM(te.duration_minutes), 0) as total_tracked_minutes,
        COALESCE(AVG(te.duration_minutes), 0) as avg_time_per_entry,

        -- Efficiency metrics
        CASE
          WHEN COUNT(DISTINCT ro.id) > 0
          THEN SUM(rll.line_total) / COUNT(DISTINCT ro.id)
          ELSE 0
        END as revenue_per_order

      FROM users u
      LEFT JOIN ro_labor_lines rll ON u.id = rll.technician_id
      LEFT JOIN repair_orders ro ON rll.repair_order_id = ro.id AND ro.status = 'completed'
      LEFT JOIN time_entries te ON u.id = te.technician_id AND te.repair_order_id = ro.id
      WHERE $1 = ANY(u.workspace_ids) AND u.active = true ${dateFilter}
      GROUP BY u.id, u.name
      ORDER BY labor_revenue DESC
    `;

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Get customer analytics
   */
  async getCustomerAnalytics(workspaceId, dateRange = {}) {
    const { startDate, endDate } = dateRange;

    let dateFilter = '';
    const params = [workspaceId];
    let paramCount = 2;

    if (startDate) {
      dateFilter += ` AND ro.created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      dateFilter += ` AND ro.created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const query = `
      SELECT
        c.id,
        c.full_name,
        c.email,
        c.created_at as customer_since,

        -- Repair order metrics
        COUNT(DISTINCT ro.id) as total_repair_orders,
        COUNT(DISTINCT CASE WHEN ro.status = 'completed' THEN ro.id END) as completed_orders,
        (SELECT COUNT(*) FROM vehicles v WHERE v.customer_id = c.id) as vehicles_owned,

        -- Financial metrics
        COALESCE(SUM(ro.total_final), 0) as total_spent,
        COALESCE(AVG(ro.total_final), 0) as avg_order_value,
        COALESCE(MAX(ro.total_final), 0) as largest_order,

        -- Timing metrics
        MAX(ro.created_at) as last_service_date,
        AVG(EXTRACT(EPOCH FROM (ro.actual_completion - ro.created_at))/86400) as avg_completion_days,

        -- Loyalty metrics
        CASE
          WHEN MAX(ro.created_at) > NOW() - INTERVAL '90 days' THEN 'Active'
          WHEN MAX(ro.created_at) > NOW() - INTERVAL '180 days' THEN 'Recent'
          ELSE 'Inactive'
        END as customer_status

      FROM customers c
      LEFT JOIN repair_orders ro ON c.id = ro.customer_id ${dateFilter}
      -- vehicles_owned is counted in a subquery: joining vehicles here would
      -- repeat every repair order once per vehicle, inflating total_spent.
      WHERE c.workspace_id = $1
      GROUP BY c.id, c.full_name, c.email, c.created_at
      ORDER BY total_spent DESC
    `;

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Get parts usage and profitability analysis
   */
  async getPartsAnalytics(workspaceId, dateRange = {}) {
    const { startDate, endDate } = dateRange;

    let dateFilter = '';
    const params = [workspaceId];
    let paramCount = 2;

    if (startDate) {
      dateFilter += ` AND ro.created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      dateFilter += ` AND ro.created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const query = `
      SELECT
        p.id,
        p.part_number,
        p.name,
        p.category,
        p.quantity_on_hand,
        p.minimum_stock,

        -- Usage metrics
        COALESCE(SUM(rpl.quantity), 0) as total_used,
        COUNT(DISTINCT ro.id) as repair_orders_used_in,
        COUNT(DISTINCT ro.customer_id) as unique_customers,

        -- Financial metrics
        COALESCE(SUM(rpl.line_total), 0) as total_revenue,
        COALESCE(AVG(rpl.unit_price), 0) as avg_selling_price,
        COALESCE(AVG(rpl.unit_cost), 0) as avg_cost,
        CASE
          WHEN SUM(rpl.quantity) > 0
          THEN (SUM(rpl.line_total) - (SUM(rpl.quantity) * AVG(rpl.unit_cost))) / SUM(rpl.line_total) * 100
          ELSE 0
        END as profit_margin_percentage,

        -- Stock metrics
        CASE
          WHEN p.quantity_on_hand <= p.minimum_stock THEN 'Low Stock'
          WHEN p.quantity_on_hand = 0 THEN 'Out of Stock'
          ELSE 'In Stock'
        END as stock_status

      FROM parts p
      LEFT JOIN ro_parts_lines rpl ON p.id = rpl.part_id
      LEFT JOIN repair_orders ro ON rpl.repair_order_id = ro.id
      WHERE p.workspace_id = $1 AND p.active = true ${dateFilter}
      GROUP BY p.id, p.part_number, p.name, p.category, p.quantity_on_hand, p.minimum_stock
      ORDER BY total_revenue DESC
    `;

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Get monthly revenue trends
   */
  async getRevenueTrends(workspaceId, months = 12) {
    /* months is bounded and passed as a parameter rather than interpolated:
       make_interval keeps it out of the SQL text entirely. */
    const safeMonths = Math.min(Math.max(Number(months) || 12, 1), 120);

    /* Parts and labor are aggregated in subqueries. Joining both line tables
       directly multiplies their rows together (one row per parts x labor
       combination), which inflated parts_revenue and labor_revenue on any RO
       that had more than one of each. */
    const query = `
      SELECT
        DATE_TRUNC('month', ro.created_at) as month,
        COUNT(*) as repair_orders,
        COALESCE(SUM(ro.total_final), 0) as total_revenue,
        COALESCE(SUM(p.parts_total), 0) as parts_revenue,
        COALESCE(SUM(l.labor_total), 0) as labor_revenue,
        COUNT(DISTINCT ro.customer_id) as unique_customers
      FROM repair_orders ro
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(line_total), 0) AS parts_total
          FROM ro_parts_lines WHERE repair_order_id = ro.id
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(line_total), 0) AS labor_total
          FROM ro_labor_lines WHERE repair_order_id = ro.id
      ) l ON true
      WHERE ro.workspace_id = $1
        AND ro.created_at >= NOW() - make_interval(months => $2::int)
        AND ro.status = 'completed'
      GROUP BY DATE_TRUNC('month', ro.created_at)
      ORDER BY month DESC
    `;

    const result = await this.pool.query(query, [workspaceId, safeMonths]);
    return result.rows;
  }

  /**
   * Get shop performance KPIs
   */
  async getShopKPIs(workspaceId, dateRange = {}) {
    const { startDate, endDate } = dateRange;

    let dateFilter = '';
    const params = [workspaceId];
    let paramCount = 2;

    if (startDate) {
      dateFilter += ` AND ro.created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      dateFilter += ` AND ro.created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const query = `
      SELECT
        -- Overall metrics
        COUNT(DISTINCT ro.id) as total_repair_orders,
        COUNT(DISTINCT CASE WHEN ro.status = 'completed' THEN ro.id END) as completed_orders,
        COUNT(DISTINCT ro.customer_id) as total_customers,
        COUNT(DISTINCT v.id) as total_vehicles,

        -- Financial KPIs
        COALESCE(SUM(ro.total_final), 0) as total_revenue,
        COALESCE(AVG(ro.total_final), 0) as avg_ticket_size,

        -- Efficiency KPIs
        AVG(EXTRACT(EPOCH FROM (ro.actual_completion - ro.created_at))/86400) as avg_completion_days,
        COUNT(CASE WHEN ro.actual_completion <= ro.estimated_completion THEN 1 END)::float /
          NULLIF(COUNT(CASE WHEN ro.estimated_completion IS NOT NULL THEN 1 END), 0) * 100 as on_time_completion_rate,

        -- Customer satisfaction
        COALESCE(AVG(fb.avg_rating), 0) as avg_customer_rating,

        -- Operational KPIs
        COUNT(CASE WHEN ro.status IN ('open', 'in_progress', 'awaiting_parts') THEN 1 END) as active_orders,
        COUNT(CASE WHEN ro.status = 'awaiting_parts' THEN 1 END) as orders_waiting_parts,

        -- Technician utilization. Counting distinct technicians has to happen
        -- over time_entries itself, so it is scoped to this workspace's ROs
        -- in a subquery rather than folded into the per-RO aggregate.
        (SELECT COUNT(DISTINCT t.technician_id)
           FROM time_entries t
           JOIN repair_orders r ON r.id = t.repair_order_id
          WHERE r.workspace_id = $1) as active_technicians,
        COALESCE(SUM(te.tracked_minutes), 0) as total_tracked_minutes

      FROM repair_orders ro
      LEFT JOIN vehicles v ON ro.vehicle_id = v.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(duration_minutes), 0) AS tracked_minutes
          FROM time_entries WHERE repair_order_id = ro.id
      ) te ON true
      LEFT JOIN LATERAL (
        SELECT AVG(rating)::numeric AS avg_rating
          FROM feedback WHERE repair_order_id = ro.id
      ) fb ON true
      WHERE ro.workspace_id = $1 ${dateFilter}
    `;

    const result = await this.pool.query(query, params);
    return result.rows[0] || {};
  }

  /**
   * Export data for external reporting tools
   */
  async exportRepairOrderData(workspaceId, format = 'json', dateRange = {}) {
    const { startDate, endDate } = dateRange;

    let dateFilter = '';
    const params = [workspaceId];
    let paramCount = 2;

    if (startDate) {
      dateFilter += ` AND ro.created_at >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      dateFilter += ` AND ro.created_at <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    const query = `
      SELECT
        ro.id, ro.ro_number, ro.status, ro.concern, ro.priority,
        ro.total_estimate, ro.total_final, ro.created_at, ro.actual_completion,
        c.full_name as customer_name, c.email as customer_email,
        v.year, v.make, v.model, v.vin,
        json_agg(
          json_build_object(
            'part_number', rpl.part_number,
            'part_name', rpl.part_name,
            'quantity', rpl.quantity,
            'unit_price', rpl.unit_price,
            'line_total', rpl.line_total
          )
        ) FILTER (WHERE rpl.id IS NOT NULL) as parts,
        json_agg(
          json_build_object(
            'technician_name', rll.technician_name,
            'description', rll.description,
            'hours', rll.hours,
            'hourly_rate', rll.hourly_rate,
            'line_total', rll.line_total
          )
        ) FILTER (WHERE rll.id IS NOT NULL) as labor
      FROM repair_orders ro
      JOIN customers c ON ro.customer_id = c.id
      JOIN vehicles v ON ro.vehicle_id = v.id
      LEFT JOIN ro_parts_lines rpl ON ro.id = rpl.repair_order_id
      LEFT JOIN ro_labor_lines rll ON ro.id = rll.repair_order_id
      WHERE ro.workspace_id = $1 ${dateFilter}
      GROUP BY ro.id, ro.ro_number, ro.status, ro.concern, ro.priority,
               ro.total_estimate, ro.total_final, ro.created_at, ro.actual_completion,
               c.full_name, c.email, v.year, v.make, v.model, v.vin
      ORDER BY ro.created_at DESC
    `;

    const result = await this.pool.query(query, params);

    if (format === 'csv') {
      // Convert to CSV format (simplified)
      return this.convertToCSV(result.rows);
    }

    return result.rows;
  }

  /**
   * Simple CSV conversion (for basic export)
   */
  convertToCSV(data) {
    if (!data.length) return '';

    const headers = Object.keys(data[0]).join(',');
    const rows = data.map(row =>
      Object.values(row).map(value =>
        typeof value === 'object' ? JSON.stringify(value) : value
      ).join(',')
    );

    return [headers, ...rows].join('\n');
  }
}

module.exports = ReportingService;