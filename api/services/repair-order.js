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
 * Repair Order Service
 * Handles all business logic for repair orders, parts, labor, and time tracking.
 *
 * Every public method takes workspaceId and scopes its reads and writes to it.
 * A repair order id that belongs to another workspace is reported as "not
 * found" rather than "forbidden", so ids cannot be probed across tenants.
 */

/* Arbitrary constant identifying the RO-number advisory lock class, so it
   cannot collide with any other advisory lock the application may take. */
const RO_NUMBER_LOCK_NAMESPACE = 4711;

const VALID_TRANSITIONS = {
  draft:          ['open', 'cancelled'],
  open:           ['in_progress', 'awaiting_parts', 'cancelled'],
  in_progress:    ['awaiting_parts', 'ready', 'completed', 'cancelled'],
  awaiting_parts: ['in_progress', 'ready', 'cancelled'],
  ready:          ['completed', 'cancelled'],
  completed:      [],
  cancelled:      [],
};

/* Fields a client may PATCH, mapped to their column and parser. */
const UPDATABLE_FIELDS = {
  concern:                  { column: 'concern',                    parse: (v) => requireString(v, 'concern') },
  notes:                    { column: 'notes',                      parse: (v) => optionalString(v) },
  priority:                 { column: 'priority',                   parse: (v) => {
    const s = String(v || '').trim();
    if (!['low', 'normal', 'high', 'urgent'].includes(s)) {
      throw new ValidationError('priority must be one of: low, normal, high, urgent.');
    }
    return s;
  } },
  estimatedCompletion:      { column: 'estimated_completion',       parse: (v) => parseDateOrNull(v, 'estimatedCompletion') },
  customerApprovalRequired: { column: 'customer_approval_required', parse: (v) => Boolean(v) },
  totalEstimate:            { column: 'total_estimate',             parse: (v) => parseNumber(v, 'totalEstimate') },
};

function parseDateOrNull(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${field} must be a valid date.`);
  return d;
}

class RepairOrderService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Assert the repair order exists in this workspace, and return its row.
   * Used inside a transaction so the RO cannot move between the check and the
   * write. Pass { forUpdate: true } to lock the row.
   */
  async assertRepairOrder(client, repairOrderId, workspaceId, { forUpdate = false } = {}) {
    const { rows } = await client.query(
      `SELECT * FROM repair_orders WHERE id = $1 AND workspace_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [repairOrderId, workspaceId]
    );
    if (!rows.length) throw new NotFoundError('Repair order not found.');
    return rows[0];
  }

  /**
   * Validate that the customer and vehicle both live in this workspace and
   * that the vehicle actually belongs to the customer.
   */
  async assertCustomerVehicle(client, customerId, vehicleId, workspaceId) {
    const { rows } = await client.query(
      `SELECT c.id AS customer_id, v.id AS vehicle_id, v.customer_id AS vehicle_owner
         FROM customers c
         LEFT JOIN vehicles v ON v.id = $2 AND v.workspace_id = $3
        WHERE c.id = $1 AND c.workspace_id = $3`,
      [customerId, vehicleId, workspaceId]
    );

    if (!rows.length) throw new NotFoundError('Customer not found.');
    const row = rows[0];
    if (row.vehicle_id == null) throw new NotFoundError('Vehicle not found.');
    if (Number(row.vehicle_owner) !== Number(customerId)) {
      throw new ValidationError('That vehicle does not belong to the selected customer.');
    }
  }

  /**
   * Create a repair order.
   */
  async createRepairOrder(workspaceId, data, createdBy) {
    const customerId = parseId(data.customerId, 'customerId');
    const vehicleId = parseId(data.vehicleId, 'vehicleId');
    const concern = requireString(data.concern, 'concern');
    const priority = data.priority ? UPDATABLE_FIELDS.priority.parse(data.priority) : 'normal';
    const estimatedCompletion = parseDateOrNull(data.estimatedCompletion, 'estimatedCompletion');
    const notes = optionalString(data.notes);
    const totalEstimate = data.totalEstimate === undefined || data.totalEstimate === null || data.totalEstimate === ''
      ? 0
      : parseNumber(data.totalEstimate, 'totalEstimate');
    const customerApprovalRequired = Boolean(data.customerApprovalRequired);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertCustomerVehicle(client, customerId, vehicleId, workspaceId);

      /* Serialise number allocation per workspace. Concurrent transactions
         cannot see each other's uncommitted rows, so two callers would
         otherwise read the same MAX and collide on the unique index. The lock
         is released when the transaction ends. */
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [RO_NUMBER_LOCK_NAMESPACE, workspaceId]);

      const roNumber = await this.nextRoNumber(client, workspaceId);

      const { rows } = await client.query(
        `INSERT INTO repair_orders (
           workspace_id, ro_number, customer_id, vehicle_id, status, concern,
           priority, estimated_completion, notes, customer_approval_required,
           total_estimate, total_final
         ) VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$10,0)
         RETURNING *`,
        [
          workspaceId, roNumber, customerId, vehicleId, concern,
          priority, estimatedCompletion, notes, customerApprovalRequired,
          totalEstimate,
        ]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Allocate the next RO number for a workspace.
   *
   * The previous `RO-${Date.now()}` scheme collided whenever two orders were
   * created in the same millisecond, which the unique index on
   * (workspace_id, ro_number) then rejected. Derive it from the workspace's
   * existing numbers instead, under the transaction's lock.
   */
  async nextRoNumber(client, workspaceId) {
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(ro_number, '\\D', '', 'g'), '')::bigint), 1000) AS max_seq
         FROM repair_orders
        WHERE workspace_id = $1 AND ro_number ~ '^RO-[0-9]+$'`,
      [workspaceId]
    );
    const next = Number(rows[0].max_seq) + 1;
    return `RO-${next}`;
  }

  /**
   * Get a repair order with customer, vehicle, parts, labor, time and feedback.
   */
  async getRepairOrder(repairOrderId, workspaceId) {
    const roQuery = `
      SELECT ro.*,
             c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
             v.vin, v.year, v.make, v.model, v.plate, v.mileage
        FROM repair_orders ro
        JOIN customers c ON ro.customer_id = c.id
        JOIN vehicles  v ON ro.vehicle_id  = v.id
       WHERE ro.id = $1 AND ro.workspace_id = $2
    `;
    const roResult = await this.pool.query(roQuery, [repairOrderId, workspaceId]);
    if (!roResult.rows.length) return null;

    const [parts, labor, time, feedback] = await Promise.all([
      this.pool.query(
        'SELECT * FROM ro_parts_lines WHERE repair_order_id = $1 ORDER BY created_at, id',
        [repairOrderId]
      ),
      this.pool.query(
        'SELECT * FROM ro_labor_lines WHERE repair_order_id = $1 ORDER BY created_at, id',
        [repairOrderId]
      ),
      this.pool.query(
        `SELECT te.*, u.name AS technician_name
           FROM time_entries te
           JOIN users u ON te.technician_id = u.id
          WHERE te.repair_order_id = $1
          ORDER BY te.start_time DESC`,
        [repairOrderId]
      ),
      /* `feedback` (005), not `repair_order_feedback` (004/006): the portal and
         the reports both use `feedback`, and nothing in the codebase has ever
         written to `repair_order_feedback`, so reading it here meant staff
         never saw a rating a customer had actually left. */
      this.pool.query(
        `SELECT id, rating, comments, feedback_type, created_at
           FROM feedback
          WHERE repair_order_id = $1 AND workspace_id = $2
          ORDER BY created_at DESC`,
        [repairOrderId, workspaceId]
      ),
    ]);

    return {
      ...roResult.rows[0],
      parts: parts.rows,
      labor: labor.rows,
      timeEntries: time.rows,
      feedback: feedback.rows,
    };
  }

  /**
   * List repair orders for a workspace, with customer/vehicle summary.
   */
  async listRepairOrders(workspaceId, { status, customerId, limit = 100, offset = 0 } = {}) {
    const params = [workspaceId];
    let sql = `
      SELECT ro.id, ro.workspace_id, ro.ro_number, ro.customer_id, ro.vehicle_id,
             ro.status, ro.priority, ro.concern, ro.total_estimate, ro.total_final,
             ro.created_at, ro.updated_at, ro.estimated_completion, ro.actual_completion,
             c.full_name AS customer_name,
             v.year, v.make, v.model, v.plate
        FROM repair_orders ro
        JOIN customers c ON ro.customer_id = c.id
        JOIN vehicles  v ON ro.vehicle_id  = v.id
       WHERE ro.workspace_id = $1
    `;

    if (status) {
      params.push(status);
      sql += ` AND ro.status = $${params.length}`;
    }
    if (customerId) {
      params.push(customerId);
      sql += ` AND ro.customer_id = $${params.length}`;
    }

    params.push(Math.min(Number(limit) || 100, 500));
    sql += ` ORDER BY ro.created_at DESC LIMIT $${params.length}`;
    params.push(Math.max(Number(offset) || 0, 0));
    sql += ` OFFSET $${params.length}`;

    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  /**
   * Update editable repair order fields.
   */
  async updateRepairOrder(repairOrderId, updates, workspaceId, updatedBy) {
    const sets = [];
    const values = [];

    Object.entries(updates || {}).forEach(([key, value]) => {
      const field = UPDATABLE_FIELDS[key];
      if (!field || value === undefined) return;
      values.push(field.parse(value));
      sets.push(`${field.column} = $${values.length}`);
    });

    if (!sets.length) {
      throw new ValidationError('No updatable fields supplied.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertRepairOrder(client, repairOrderId, workspaceId, { forUpdate: true });

      values.push(repairOrderId, workspaceId);
      const { rows } = await client.query(
        `UPDATE repair_orders
            SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
          RETURNING *`,
        values
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Change status, enforcing the workflow.
   */
  async updateRepairOrderStatus(repairOrderId, newStatus, workspaceId, updatedBy) {
    if (!Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, newStatus)) {
      throw new ValidationError('Invalid status value.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await this.assertRepairOrder(client, repairOrderId, workspaceId, { forUpdate: true });

      if (current.status === newStatus) {
        await client.query('COMMIT');
        return current;
      }

      if (!this.isValidStatusTransition(current.status, newStatus)) {
        throw new ConflictError(`Cannot change status from ${current.status} to ${newStatus}.`);
      }

      const { rows } = await client.query(
        `UPDATE repair_orders
            SET status = $1,
                updated_at = NOW(),
                actual_completion = CASE WHEN $1 = 'completed' THEN NOW() ELSE actual_completion END
          WHERE id = $2 AND workspace_id = $3
          RETURNING *`,
        [newStatus, repairOrderId, workspaceId]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  isValidStatusTransition(fromStatus, toStatus) {
    return VALID_TRANSITIONS[fromStatus]?.includes(toStatus) || false;
  }

  /**
   * Add a part line and recalculate totals.
   */
  async addPartToRepairOrder(repairOrderId, partData, workspaceId, addedBy) {
    const data = partData || {};
    const quantity = parseNumber(data.quantity === undefined ? 1 : data.quantity, 'quantity', {
      min: 1, integer: true, max: 100000,
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertRepairOrder(client, repairOrderId, workspaceId, { forUpdate: true });

      /* Resolve the catalog part, scoped to this workspace. */
      let part = null;
      if (data.partId !== undefined && data.partId !== null && data.partId !== '') {
        const partId = parseId(data.partId, 'partId');
        const { rows } = await client.query(
          'SELECT * FROM parts WHERE id = $1 AND workspace_id = $2',
          [partId, workspaceId]
        );
        if (!rows.length) throw new NotFoundError('Part not found.');
        part = rows[0];
      }

      const partNumber = optionalString(data.partNumber) || part?.part_number;
      const partName = optionalString(data.partName) || part?.name;
      if (!partNumber || !partName) {
        throw new ValidationError('partId, or both partNumber and partName, are required.');
      }

      const unitCost = data.unitCost !== undefined && data.unitCost !== null && data.unitCost !== ''
        ? parseNumber(data.unitCost, 'unitCost')
        : Number(part?.cost_price || 0);
      const unitPrice = data.unitPrice !== undefined && data.unitPrice !== null && data.unitPrice !== ''
        ? parseNumber(data.unitPrice, 'unitPrice')
        : Number(part?.retail_price || 0);

      const lineTotal = Number((quantity * unitPrice).toFixed(2));

      const { rows } = await client.query(
        `INSERT INTO ro_parts_lines (
           workspace_id, repair_order_id, part_id, part_number, part_name,
           quantity, unit_cost, unit_price, line_total
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          workspaceId, repairOrderId, part?.id || null, partNumber, partName,
          quantity, unitCost, unitPrice, lineTotal,
        ]
      );

      /* Draw stock down for catalog parts. */
      if (part) {
        const { rows: stock } = await client.query(
          `UPDATE parts
              SET quantity_on_hand = GREATEST(quantity_on_hand - $1, 0), updated_at = NOW()
            WHERE id = $2 AND workspace_id = $3
            RETURNING quantity_on_hand`,
          [quantity, part.id, workspaceId]
        );
        if (stock.length) rows[0].part_quantity_on_hand = stock[0].quantity_on_hand;
      }

      await client.query('SELECT recalculate_ro_totals($1)', [repairOrderId]);
      const totals = await this.readTotals(client, repairOrderId);

      await client.query('COMMIT');
      return { ...rows[0], totals };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Add a labor line and recalculate totals.
   */
  async addLaborToRepairOrder(repairOrderId, laborData, workspaceId, addedBy) {
    const data = laborData || {};
    const description = requireString(data.description, 'description');
    const hours = parseNumber(data.hours, 'hours', { min: 0.01, max: 1000 });
    const hourlyRate = parseNumber(data.hourlyRate, 'hourlyRate', { min: 0, max: 100000 });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertRepairOrder(client, repairOrderId, workspaceId, { forUpdate: true });

      /* A technician must be a member of this workspace. */
      let technicianId = null;
      let technicianName = null;
      const rawTech = data.technicianId !== undefined && data.technicianId !== null && data.technicianId !== ''
        ? data.technicianId
        : addedBy;

      if (rawTech) {
        technicianId = parseId(rawTech, 'technicianId');
        const { rows } = await client.query(
          'SELECT name FROM users WHERE id = $1 AND $2 = ANY(workspace_ids) AND active = true',
          [technicianId, workspaceId]
        );
        if (!rows.length) throw new ValidationError('That technician is not a member of this workspace.');
        technicianName = rows[0].name;
      }

      const lineTotal = Number((hours * hourlyRate).toFixed(2));

      const { rows } = await client.query(
        `INSERT INTO ro_labor_lines (
           workspace_id, repair_order_id, technician_id, technician_name,
           description, hours, hourly_rate, line_total
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [workspaceId, repairOrderId, technicianId, technicianName, description, hours, hourlyRate, lineTotal]
      );

      await client.query('SELECT recalculate_ro_totals($1)', [repairOrderId]);
      const totals = await this.readTotals(client, repairOrderId);

      await client.query('COMMIT');
      return { ...rows[0], totals };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async readTotals(client, repairOrderId) {
    const { rows } = await client.query(
      `SELECT total_estimate, total_final,
              (SELECT COALESCE(SUM(line_total),0) FROM ro_parts_lines WHERE repair_order_id = $1) AS parts_total,
              (SELECT COALESCE(SUM(line_total),0) FROM ro_labor_lines WHERE repair_order_id = $1) AS labor_total
         FROM repair_orders WHERE id = $1`,
      [repairOrderId]
    );
    return rows[0];
  }

  /**
   * Clock a technician onto a repair order.
   *
   * A technician may only have one open entry at a time, across all repair
   * orders; the partial unique index enforces that under concurrency.
   */
  async clockIn(repairOrderId, technicianId, workspaceId, description) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertRepairOrder(client, repairOrderId, workspaceId);

      const { rows: open } = await client.query(
        `SELECT te.id, te.repair_order_id
           FROM time_entries te
           JOIN repair_orders ro ON ro.id = te.repair_order_id
          WHERE te.technician_id = $1 AND te.end_time IS NULL
          FOR UPDATE OF te`,
        [technicianId]
      );

      if (open.length) {
        throw new ConflictError(
          Number(open[0].repair_order_id) === Number(repairOrderId)
            ? 'You are already clocked in to this repair order.'
            : `You are already clocked in to repair order ${open[0].repair_order_id}. Clock out first.`
        );
      }

      const { rows } = await client.query(
        `INSERT INTO time_entries (repair_order_id, technician_id, start_time, description)
         VALUES ($1, $2, NOW(), $3)
         RETURNING *`,
        [repairOrderId, technicianId, optionalString(description)]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Clock the technician's open entry on this repair order back out.
   */
  async clockOut(repairOrderId, technicianId, workspaceId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertRepairOrder(client, repairOrderId, workspaceId);

      const { rows: open } = await client.query(
        `SELECT * FROM time_entries
          WHERE repair_order_id = $1 AND technician_id = $2 AND end_time IS NULL
          ORDER BY start_time DESC
          LIMIT 1
          FOR UPDATE`,
        [repairOrderId, technicianId]
      );

      if (!open.length) {
        throw new ConflictError('You are not clocked in to this repair order.');
      }

      const { rows } = await client.query(
        `UPDATE time_entries
            SET end_time = NOW(),
                duration_minutes = GREATEST(ROUND(EXTRACT(EPOCH FROM (NOW() - start_time)) / 60)::int, 0)
          WHERE id = $1
          RETURNING *`,
        [open[0].id]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The technician's currently open time entry, if any.
   */
  async getOpenTimeEntry(technicianId, workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT te.*, ro.ro_number
         FROM time_entries te
         JOIN repair_orders ro ON ro.id = te.repair_order_id
        WHERE te.technician_id = $1 AND te.end_time IS NULL AND ro.workspace_id = $2
        ORDER BY te.start_time DESC
        LIMIT 1`,
      [technicianId, workspaceId]
    );
    return rows[0] || null;
  }
}

module.exports = RepairOrderService;
