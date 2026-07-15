const {
  NotFoundError,
  ConflictError,
  requireString,
  optionalString,
} = require('./errors');

/**
 * Customer Service
 * Customer records, their vehicles, and their service history.
 *
 * Every method takes workspaceId and filters on it. Callers pass the id
 * resolved from the session, never one supplied by the client.
 */

class CustomerService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * List customers with vehicle and spend roll-ups.
   */
  async listCustomers(workspaceId, { search, limit = 100, offset = 0 } = {}) {
    const params = [workspaceId];
    let sql = `
      SELECT
        c.id, c.workspace_id, c.full_name, c.email, c.phone,
        c.portal_enabled, c.last_portal_login, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM vehicles v WHERE v.customer_id = c.id)      AS vehicle_count,
        (SELECT COUNT(*) FROM repair_orders r WHERE r.customer_id = c.id) AS repair_order_count,
        (SELECT COALESCE(SUM(r.total_final),0) FROM repair_orders r WHERE r.customer_id = c.id) AS total_spent,
        (SELECT MAX(r.created_at) FROM repair_orders r WHERE r.customer_id = c.id) AS last_service_date
      FROM customers c
      WHERE c.workspace_id = $1
    `;

    const term = typeof search === 'string' ? search.trim() : '';
    if (term) {
      params.push(`%${term}%`);
      sql += ` AND (c.full_name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.phone ILIKE $${params.length})`;
    }

    params.push(Math.min(Number(limit) || 100, 500));
    sql += ` ORDER BY c.created_at DESC LIMIT $${params.length}`;
    params.push(Math.max(Number(offset) || 0, 0));
    sql += ` OFFSET $${params.length}`;

    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  /**
   * One customer with their vehicles.
   */
  async getCustomer(customerId, workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT
         c.id, c.workspace_id, c.full_name, c.email, c.phone,
         c.address, c.city, c.state, c.zip_code,
         c.portal_enabled, c.last_portal_login, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM repair_orders r WHERE r.customer_id = c.id) AS repair_order_count,
         (SELECT COALESCE(SUM(r.total_final),0) FROM repair_orders r WHERE r.customer_id = c.id) AS total_spent,
         (SELECT MAX(r.created_at) FROM repair_orders r WHERE r.customer_id = c.id) AS last_service_date
       FROM customers c
      WHERE c.id = $1 AND c.workspace_id = $2`,
      [customerId, workspaceId]
    );
    if (!rows.length) return null;

    const { rows: vehicles } = await this.pool.query(
      `SELECT id, vin, year, make, model, plate, mileage, created_at
         FROM vehicles
        WHERE customer_id = $1 AND workspace_id = $2
        ORDER BY created_at DESC`,
      [customerId, workspaceId]
    );

    return { ...rows[0], vehicles };
  }

  /**
   * Create a customer.
   */
  async createCustomer(data, workspaceId) {
    const fullName = requireString(data?.fullName ?? data?.full_name, 'fullName', { max: 200 });
    const email = optionalString(data?.email, { max: 200 });
    const phone = optionalString(data?.phone, { max: 40 });

    if (email) {
      const { rows: dup } = await this.pool.query(
        'SELECT id FROM customers WHERE workspace_id = $1 AND lower(email) = lower($2)',
        [workspaceId, email]
      );
      if (dup.length) throw new ConflictError('A customer with that email already exists.');
    }

    const { rows } = await this.pool.query(
      `INSERT INTO customers (workspace_id, full_name, email, phone,
                              address, city, state, zip_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, workspace_id, full_name, email, phone,
                 address, city, state, zip_code, created_at, updated_at`,
      [
        workspaceId, fullName, email ? email.toLowerCase() : null, phone,
        optionalString(data?.address, { max: 300 }),
        optionalString(data?.city, { max: 120 }),
        optionalString(data?.state, { max: 60 }),
        optionalString(data?.zipCode ?? data?.zip_code, { max: 20 }),
      ]
    );

    return rows[0];
  }

  /**
   * Full service history: the customer, their vehicles, and every repair
   * order with its parts and labor.
   *
   * This backs GET /api/customers/:id/history, which previously called a
   * Mitchell ETL placeholder that always returned null (so the endpoint
   * always 404'd and the history page shipped hardcoded data instead).
   */
  async getCustomerHistory(workspaceId, customerId) {
    const { rows: customerRows } = await this.pool.query(
      `SELECT id, workspace_id, full_name, email, phone,
              address, city, state, zip_code, created_at
         FROM customers
        WHERE id = $1 AND workspace_id = $2`,
      [customerId, workspaceId]
    );
    if (!customerRows.length) return null;

    const [vehicles, repairOrders, totals] = await Promise.all([
      this.pool.query(
        `SELECT v.id, v.vin, v.year, v.make, v.model, v.plate, v.mileage, v.created_at,
                (SELECT COUNT(*) FROM repair_orders r WHERE r.vehicle_id = v.id) AS repair_order_count,
                (SELECT MAX(r.created_at) FROM repair_orders r WHERE r.vehicle_id = v.id) AS last_service_date
           FROM vehicles v
          WHERE v.customer_id = $1 AND v.workspace_id = $2
          ORDER BY v.created_at DESC`,
        [customerId, workspaceId]
      ),
      this.pool.query(
        `SELECT
           ro.id, ro.ro_number, ro.status, ro.priority, ro.concern, ro.notes,
           ro.total_estimate, ro.total_final, ro.created_at, ro.updated_at,
           ro.estimated_completion, ro.actual_completion,
           ro.vehicle_id, v.year, v.make, v.model, v.plate, v.vin,
           (SELECT json_agg(json_build_object(
                     'part_number', p.part_number, 'part_name', p.part_name,
                     'quantity', p.quantity, 'unit_price', p.unit_price,
                     'line_total', p.line_total) ORDER BY p.id)
              FROM ro_parts_lines p WHERE p.repair_order_id = ro.id) AS parts,
           (SELECT json_agg(json_build_object(
                     'description', l.description, 'technician_name', l.technician_name,
                     'hours', l.hours, 'hourly_rate', l.hourly_rate,
                     'line_total', l.line_total) ORDER BY l.id)
              FROM ro_labor_lines l WHERE l.repair_order_id = ro.id) AS labor
         FROM repair_orders ro
         JOIN vehicles v ON v.id = ro.vehicle_id
        WHERE ro.customer_id = $1 AND ro.workspace_id = $2
        ORDER BY ro.created_at DESC`,
        [customerId, workspaceId]
      ),
      this.pool.query(
        `SELECT
           COUNT(*)                                  AS total_repair_orders,
           COUNT(*) FILTER (WHERE status = 'completed') AS completed_orders,
           COALESCE(SUM(total_final), 0)             AS total_spent,
           COALESCE(AVG(total_final), 0)             AS avg_order_value,
           MAX(created_at)                           AS last_service_date,
           MIN(created_at)                           AS first_service_date
         FROM repair_orders
        WHERE customer_id = $1 AND workspace_id = $2`,
        [customerId, workspaceId]
      ),
    ]);

    return {
      customer: customerRows[0],
      vehicles: vehicles.rows,
      repairOrders: repairOrders.rows,
      summary: totals.rows[0],
    };
  }
}

module.exports = CustomerService;
