const {
  ValidationError,
  NotFoundError,
  ConflictError,
  parseId,
  parseNumber,
  requireString,
  optionalString,
} = require('./errors');

/**
 * Vehicle Service
 * Vehicle records, always scoped to a workspace and owned by a customer in
 * that same workspace.
 */

const CURRENT_YEAR = new Date().getFullYear();

class VehicleService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * List vehicles, optionally filtered to one customer.
   */
  async listVehicles(workspaceId, { customerId, search, limit = 200, offset = 0 } = {}) {
    const params = [workspaceId];
    let sql = `
      SELECT v.id, v.workspace_id, v.customer_id, v.vin, v.year, v.make, v.model,
             v.plate, v.mileage, v.created_at, v.updated_at,
             c.full_name AS customer_name,
             (SELECT COUNT(*) FROM repair_orders r WHERE r.vehicle_id = v.id) AS repair_order_count,
             (SELECT MAX(r.created_at) FROM repair_orders r WHERE r.vehicle_id = v.id) AS last_service_date
        FROM vehicles v
        LEFT JOIN customers c ON c.id = v.customer_id
       WHERE v.workspace_id = $1
    `;

    if (customerId) {
      params.push(customerId);
      sql += ` AND v.customer_id = $${params.length}`;
    }

    const term = typeof search === 'string' ? search.trim() : '';
    if (term) {
      params.push(`%${term}%`);
      sql += ` AND (v.vin ILIKE $${params.length} OR v.plate ILIKE $${params.length}` +
             ` OR v.make ILIKE $${params.length} OR v.model ILIKE $${params.length})`;
    }

    params.push(Math.min(Number(limit) || 200, 500));
    sql += ` ORDER BY v.created_at DESC LIMIT $${params.length}`;
    params.push(Math.max(Number(offset) || 0, 0));
    sql += ` OFFSET $${params.length}`;

    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  async getVehicle(vehicleId, workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT v.*, c.full_name AS customer_name
         FROM vehicles v
         LEFT JOIN customers c ON c.id = v.customer_id
        WHERE v.id = $1 AND v.workspace_id = $2`,
      [vehicleId, workspaceId]
    );
    return rows[0] || null;
  }

  /**
   * Register a vehicle against a customer in this workspace.
   */
  async createVehicle(data, workspaceId) {
    const customerId = parseId(data?.customerId ?? data?.customer_id, 'customerId');
    const vin = requireString(data?.vin, 'vin', { max: 64 }).toUpperCase();
    const make = requireString(data?.make, 'make', { max: 80 });
    const model = requireString(data?.model, 'model', { max: 80 });

    const year = data?.year === undefined || data?.year === null || data?.year === ''
      ? null
      : parseNumber(data.year, 'year', { min: 1900, max: CURRENT_YEAR + 2, integer: true });
    const mileage = data?.mileage === undefined || data?.mileage === null || data?.mileage === ''
      ? null
      : parseNumber(data.mileage, 'mileage', { min: 0, max: 2000000, integer: true });

    /* The customer must exist in this workspace: a vehicle may not be
       attached to another tenant's customer. */
    const { rows: owner } = await this.pool.query(
      'SELECT id FROM customers WHERE id = $1 AND workspace_id = $2',
      [customerId, workspaceId]
    );
    if (!owner.length) throw new NotFoundError('Customer not found.');

    try {
      const { rows } = await this.pool.query(
        `INSERT INTO vehicles (workspace_id, customer_id, vin, year, make, model, plate, mileage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, workspace_id, customer_id, vin, year, make, model, plate, mileage, created_at, updated_at`,
        [workspaceId, customerId, vin, year, make, model, optionalString(data?.plate, { max: 20 }), mileage]
      );
      return rows[0];
    } catch (e) {
      /* Backed by idx_vehicles_ws_vin. */
      if (e.code === '23505') throw new ConflictError('A vehicle with that VIN already exists in this workspace.');
      throw e;
    }
  }

  /**
   * Update a vehicle's mutable fields.
   */
  async updateVehicle(vehicleId, updates, workspaceId) {
    const fields = {
      vin:      { column: 'vin',     parse: (v) => requireString(v, 'vin', { max: 64 }).toUpperCase() },
      make:     { column: 'make',    parse: (v) => requireString(v, 'make', { max: 80 }) },
      model:    { column: 'model',   parse: (v) => requireString(v, 'model', { max: 80 }) },
      plate:    { column: 'plate',   parse: (v) => optionalString(v, { max: 20 }) },
      year:     { column: 'year',    parse: (v) => parseNumber(v, 'year', { min: 1900, max: CURRENT_YEAR + 2, integer: true }) },
      mileage:  { column: 'mileage', parse: (v) => parseNumber(v, 'mileage', { min: 0, max: 2000000, integer: true }) },
    };

    const sets = [];
    const values = [];

    Object.entries(updates || {}).forEach(([key, value]) => {
      const field = fields[key];
      if (!field || value === undefined) return;
      values.push(field.parse(value));
      sets.push(`${field.column} = $${values.length}`);
    });

    if (!sets.length) throw new ValidationError('No updatable fields supplied.');

    values.push(vehicleId, workspaceId);
    try {
      const { rows } = await this.pool.query(
        `UPDATE vehicles SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
          RETURNING *`,
        values
      );
      if (!rows.length) throw new NotFoundError('Vehicle not found.');
      return rows[0];
    } catch (e) {
      if (e.code === '23505') throw new ConflictError('A vehicle with that VIN already exists in this workspace.');
      throw e;
    }
  }
}

module.exports = VehicleService;
