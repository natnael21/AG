const {
  ValidationError,
  NotFoundError,
  ConflictError,
  parseNumber,
  requireString,
  optionalString,
} = require('./errors');

/**
 * Parts Management Service
 * Handles parts catalog, inventory, and stock management.
 *
 * Argument order across this service is (id..., data, workspaceId, actorId) to
 * match how the routes call it. Every statement is scoped by workspace_id.
 */

/* Columns a client may write, with their parsers. Anything not listed here is
   ignored: update payloads are turned into a fixed set of parameterised
   assignments rather than interpolated from the request's own keys. */
const WRITABLE = {
  partNumber:     { column: 'part_number',      parse: (v) => requireString(v, 'partNumber', { max: 120 }) },
  name:           { column: 'name',             parse: (v) => requireString(v, 'name', { max: 200 }) },
  description:    { column: 'description',      parse: (v) => optionalString(v) },
  category:       { column: 'category',         parse: (v) => optionalString(v, { max: 120 }) },
  manufacturer:   { column: 'manufacturer',     parse: (v) => optionalString(v, { max: 120 }) },
  costPrice:      { column: 'cost_price',       parse: (v) => parseNumber(v, 'costPrice') },
  retailPrice:    { column: 'retail_price',     parse: (v) => parseNumber(v, 'retailPrice') },
  quantityOnHand: { column: 'quantity_on_hand', parse: (v) => parseNumber(v, 'quantityOnHand', { integer: true }) },
  minimumStock:   { column: 'minimum_stock',    parse: (v) => parseNumber(v, 'minimumStock', { integer: true }) },
  location:       { column: 'location',         parse: (v) => optionalString(v, { max: 120 }) },
  active:         { column: 'active',           parse: (v) => Boolean(v) },
};

/* Accept snake_case aliases too, since the catalog rows are returned that way. */
const ALIASES = Object.entries(WRITABLE).reduce((acc, [key, meta]) => {
  acc[key] = meta;
  acc[meta.column] = meta;
  return acc;
}, {});

class PartsService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * List catalog parts, optionally filtered by category.
   */
  async getAllParts(workspaceId, category) {
    const params = [workspaceId];
    let sql = `
      SELECT *, (quantity_on_hand <= minimum_stock) AS is_low_stock
        FROM parts
       WHERE workspace_id = $1 AND active = true
    `;
    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }
    sql += ' ORDER BY name';

    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  async getPart(partId, workspaceId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM parts WHERE id = $1 AND workspace_id = $2',
      [partId, workspaceId]
    );
    return rows[0] || null;
  }

  /**
   * Create a catalog part.
   */
  async createPart(partData, workspaceId, createdBy) {
    const data = partData || {};
    const partNumber = requireString(data.partNumber ?? data.part_number, 'partNumber', { max: 120 });
    const name = requireString(data.name, 'name', { max: 200 });

    const costPrice = data.costPrice ?? data.cost_price;
    const retailPrice = data.retailPrice ?? data.retail_price;
    const quantityOnHand = data.quantityOnHand ?? data.quantity_on_hand;
    const minimumStock = data.minimumStock ?? data.minimum_stock;

    const values = [
      workspaceId,
      partNumber,
      name,
      optionalString(data.description),
      optionalString(data.category, { max: 120 }),
      optionalString(data.manufacturer, { max: 120 }),
      costPrice === undefined || costPrice === null || costPrice === '' ? null : parseNumber(costPrice, 'costPrice'),
      retailPrice === undefined || retailPrice === null || retailPrice === '' ? null : parseNumber(retailPrice, 'retailPrice'),
      quantityOnHand === undefined || quantityOnHand === null || quantityOnHand === ''
        ? 0 : parseNumber(quantityOnHand, 'quantityOnHand', { integer: true }),
      minimumStock === undefined || minimumStock === null || minimumStock === ''
        ? 0 : parseNumber(minimumStock, 'minimumStock', { integer: true }),
      optionalString(data.location, { max: 120 }),
    ];

    try {
      const { rows } = await this.pool.query(
        `INSERT INTO parts (
           workspace_id, part_number, name, description, category,
           manufacturer, cost_price, retail_price, quantity_on_hand,
           minimum_stock, location
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        values
      );
      return rows[0];
    } catch (e) {
      /* Backed by idx_parts_ws_part_number. */
      if (e.code === '23505') {
        throw new ConflictError('That part number already exists in this workspace.');
      }
      throw e;
    }
  }

  /**
   * Update a catalog part.
   */
  async updatePart(partId, updates, workspaceId, updatedBy) {
    const sets = [];
    const values = [];

    Object.entries(updates || {}).forEach(([key, value]) => {
      const field = ALIASES[key];
      if (!field || value === undefined) return;
      values.push(field.parse(value));
      sets.push(`${field.column} = $${values.length}`);
    });

    if (!sets.length) throw new ValidationError('No updatable fields supplied.');

    values.push(partId, workspaceId);
    try {
      const { rows } = await this.pool.query(
        `UPDATE parts
            SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
          RETURNING *`,
        values
      );
      if (!rows.length) throw new NotFoundError('Part not found.');
      return rows[0];
    } catch (e) {
      if (e.code === '23505') {
        throw new ConflictError('That part number already exists in this workspace.');
      }
      throw e;
    }
  }

  /**
   * Adjust stock on hand by a signed amount.
   */
  async adjustInventory(partId, adjustment, reason, workspaceId, performedBy) {
    const delta = parseNumber(adjustment, 'adjustment', { min: -1e6, max: 1e6, integer: true });
    if (delta === 0) throw new ValidationError('adjustment must not be zero.');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: current } = await client.query(
        'SELECT quantity_on_hand, name FROM parts WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
        [partId, workspaceId]
      );
      if (!current.length) throw new NotFoundError('Part not found.');

      const newQuantity = Number(current[0].quantity_on_hand) + delta;
      if (newQuantity < 0) throw new ValidationError('Cannot reduce inventory below zero.');

      const { rows } = await client.query(
        `UPDATE parts SET quantity_on_hand = $1, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3
          RETURNING *`,
        [newQuantity, partId, workspaceId]
      );

      await client.query('COMMIT');
      console.log(
        `[Inventory] ws=${workspaceId} part=${partId} ${current[0].quantity_on_hand} -> ${newQuantity} ` +
        `by user ${performedBy}: ${reason || 'no reason given'}`
      );
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Parts at or below their minimum stock level.
   */
  async getLowStockParts(workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT *,
              true AS is_low_stock,
              (quantity_on_hand - minimum_stock) AS stock_deficit
         FROM parts
        WHERE workspace_id = $1
          AND active = true
          AND quantity_on_hand <= minimum_stock
        ORDER BY (quantity_on_hand - minimum_stock) ASC`,
      [workspaceId]
    );
    return rows;
  }

  /**
   * Free-text search across part number, name and description.
   */
  async searchParts(search, workspaceId, { category, manufacturer, inStockOnly = false } = {}) {
    const term = typeof search === 'string' ? search.trim() : '';

    let sql = 'SELECT * FROM parts WHERE workspace_id = $1 AND active = true';
    const params = [workspaceId];

    if (term) {
      params.push(`%${term}%`);
      sql += ` AND (part_number ILIKE $${params.length} OR name ILIKE $${params.length} OR description ILIKE $${params.length})`;
    }
    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }
    if (manufacturer) {
      params.push(manufacturer);
      sql += ` AND manufacturer = $${params.length}`;
    }
    if (inStockOnly) sql += ' AND quantity_on_hand > 0';

    sql += ' ORDER BY name';

    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  /**
   * Usage statistics for one part.
   */
  async getPartUsageStats(partId, workspaceId, dateRange = {}) {
    const { startDate, endDate } = dateRange || {};
    const params = [partId, workspaceId];
    let dateFilter = '';

    if (startDate) {
      params.push(startDate);
      dateFilter += ` AND ro.created_at >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      dateFilter += ` AND ro.created_at <= $${params.length}`;
    }

    const { rows } = await this.pool.query(
      `SELECT
         COUNT(DISTINCT ro.id)         AS total_repair_orders,
         COALESCE(SUM(rpl.quantity),0) AS total_quantity_used,
         COALESCE(AVG(rpl.unit_price),0) AS avg_price,
         COALESCE(SUM(rpl.line_total),0) AS total_revenue
       FROM ro_parts_lines rpl
       JOIN repair_orders ro ON rpl.repair_order_id = ro.id
      WHERE rpl.part_id = $1 AND ro.workspace_id = $2 ${dateFilter}`,
      params
    );

    return rows[0] || {
      total_repair_orders: 0,
      total_quantity_used: 0,
      avg_price: 0,
      total_revenue: 0,
    };
  }

  /**
   * Bulk import parts. Each row is independent: a bad row is reported and
   * skipped rather than aborting the batch.
   */
  async bulkImportParts(workspaceId, partsData, performedBy) {
    const results = { success: 0, errors: [], duplicates: [] };

    for (const partData of partsData || []) {
      const partNumber = partData?.partNumber ?? partData?.part_number;
      try {
        await this.createPart(partData, workspaceId, performedBy);
        results.success++;
      } catch (e) {
        if (e instanceof ConflictError) {
          results.duplicates.push({ partNumber, reason: 'Part number already exists' });
        } else {
          results.errors.push({ partNumber, error: e.message });
        }
      }
    }

    return results;
  }
}

module.exports = PartsService;
