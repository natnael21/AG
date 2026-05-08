const { v4: uuidv4 } = require('uuid');

/**
 * Repair Order Service
 * Handles all business logic for repair orders, parts, labor, and time tracking
 */

class RepairOrderService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Create a new repair order with initial data
   */
  async createRepairOrder(workspaceId, data, createdBy) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const {
        customerId,
        vehicleId,
        concern,
        priority = 'normal',
        estimatedCompletion,
        notes,
        customerApprovalRequired = false
      } = data;

      // Validate required fields
      if (!customerId || !vehicleId || !concern) {
        throw new Error('customerId, vehicleId, and concern are required');
      }

      // Generate RO number
      const roNumber = `RO-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

      // Create repair order
      const roQuery = `
        INSERT INTO repair_orders (
          workspace_id, ro_number, customer_id, vehicle_id, status,
          concern, priority, estimated_completion, notes, customer_approval_required
        ) VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9)
        RETURNING *
      `;

      const roValues = [
        workspaceId, roNumber, customerId, vehicleId, concern,
        priority, estimatedCompletion, notes, customerApprovalRequired
      ];

      const roResult = await client.query(roQuery, roValues);
      const repairOrder = roResult.rows[0];

      await client.query('COMMIT');
      return repairOrder;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Add a part to a repair order
   */
  async addPartToRepairOrder(repairOrderId, partData) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const { partId, quantity = 1, unitPrice, unitCost } = partData;

      // Get part details if partId provided
      let partDetails = null;
      if (partId) {
        const partResult = await client.query(
          'SELECT * FROM parts WHERE id = $1',
          [partId]
        );
        if (partResult.rows.length === 0) {
          throw new Error('Part not found');
        }
        partDetails = partResult.rows[0];
      }

      // Use provided values or fall back to part catalog
      const finalPartNumber = partData.partNumber || partDetails?.part_number || 'UNKNOWN';
      const finalPartName = partData.partName || partDetails?.name || 'Unknown Part';
      const finalUnitCost = unitCost !== undefined ? unitCost : partDetails?.cost_price || 0;
      const finalUnitPrice = unitPrice !== undefined ? unitPrice : partDetails?.retail_price || 0;
      const lineTotal = quantity * finalUnitPrice;

      // Add parts line
      const insertQuery = `
        INSERT INTO ro_parts_lines (
          repair_order_id, part_id, part_number, part_name,
          quantity, unit_cost, unit_price, line_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `;

      const values = [
        repairOrderId, partId || null, finalPartNumber, finalPartName,
        quantity, finalUnitCost, finalUnitPrice, lineTotal
      ];

      const result = await client.query(insertQuery, values);

      // Recalculate totals
      await client.query('SELECT recalculate_ro_totals($1)', [repairOrderId]);

      await client.query('COMMIT');
      return result.rows[0];

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Add labor to a repair order
   */
  async addLaborToRepairOrder(repairOrderId, laborData) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const { technicianId, description, hours, hourlyRate } = laborData;

      if (!description || !hours || hourlyRate === undefined) {
        throw new Error('description, hours, and hourlyRate are required');
      }

      // Get technician name if provided
      let technicianName = null;
      if (technicianId) {
        const techResult = await client.query(
          'SELECT name FROM users WHERE id = $1',
          [technicianId]
        );
        technicianName = techResult.rows[0]?.name;
      }

      const lineTotal = hours * hourlyRate;

      // Add labor line
      const insertQuery = `
        INSERT INTO ro_labor_lines (
          repair_order_id, technician_id, technician_name,
          description, hours, hourly_rate, line_total
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `;

      const values = [
        repairOrderId, technicianId || null, technicianName,
        description, hours, hourlyRate, lineTotal
      ];

      const result = await client.query(insertQuery, values);

      // Recalculate totals
      await client.query('SELECT recalculate_ro_totals($1)', [repairOrderId]);

      await client.query('COMMIT');
      return result.rows[0];

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update repair order status with workflow validation
   */
  async updateRepairOrderStatus(repairOrderId, newStatus, updatedBy) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Get current status
      const currentResult = await client.query(
        'SELECT status FROM repair_orders WHERE id = $1',
        [repairOrderId]
      );

      if (currentResult.rows.length === 0) {
        throw new Error('Repair order not found');
      }

      const currentStatus = currentResult.rows[0].status;

      // Validate status transition
      if (!this.isValidStatusTransition(currentStatus, newStatus)) {
        throw new Error(`Invalid status transition from ${currentStatus} to ${newStatus}`);
      }

      // Update status
      const updateData = { status: newStatus, updated_at: new Date() };

      // Set completion timestamp if completing
      if (newStatus === 'completed') {
        updateData.actual_completion = new Date();
      }

      const updateQuery = `
        UPDATE repair_orders
        SET status = $1, updated_at = $2, actual_completion = $3
        WHERE id = $4
        RETURNING *
      `;

      const result = await client.query(updateQuery, [
        newStatus, updateData.updated_at, updateData.actual_completion, repairOrderId
      ]);

      await client.query('COMMIT');
      return result.rows[0];

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Validate status transitions
   */
  isValidStatusTransition(fromStatus, toStatus) {
    const validTransitions = {
      'draft': ['open', 'cancelled'],
      'open': ['in_progress', 'awaiting_parts', 'cancelled'],
      'in_progress': ['awaiting_parts', 'ready', 'completed', 'cancelled'],
      'awaiting_parts': ['in_progress', 'ready', 'cancelled'],
      'ready': ['completed', 'cancelled'],
      'completed': [], // Terminal state
      'cancelled': []  // Terminal state
    };

    return validTransitions[fromStatus]?.includes(toStatus) || false;
  }

  /**
   * Clock in/out for time tracking
   */
  async clockIn(repairOrderId, technicianId, description) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Check if already clocked in
      const existingResult = await client.query(
        'SELECT id FROM time_entries WHERE technician_id = $1 AND end_time IS NULL',
        [technicianId]
      );

      if (existingResult.rows.length > 0) {
        throw new Error('Technician is already clocked in');
      }

      // Create time entry
      const insertQuery = `
        INSERT INTO time_entries (repair_order_id, technician_id, start_time, description)
        VALUES ($1, $2, NOW(), $3)
        RETURNING *
      `;

      const result = await client.query(insertQuery, [
        repairOrderId, technicianId, description || null
      ]);

      await client.query('COMMIT');
      return result.rows[0];

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Clock out and calculate duration
   */
  async clockOut(timeEntryId) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Get time entry
      const entryResult = await client.query(
        'SELECT * FROM time_entries WHERE id = $1 AND end_time IS NULL',
        [timeEntryId]
      );

      if (entryResult.rows.length === 0) {
        throw new Error('Time entry not found or already clocked out');
      }

      const entry = entryResult.rows[0];
      const endTime = new Date();
      const durationMinutes = Math.round((endTime - new Date(entry.start_time)) / (1000 * 60));

      // Update time entry
      const updateQuery = `
        UPDATE time_entries
        SET end_time = $1, duration_minutes = $2
        WHERE id = $3
        RETURNING *
      `;

      const result = await client.query(updateQuery, [
        endTime, durationMinutes, timeEntryId
      ]);

      await client.query('COMMIT');
      return result.rows[0];

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get detailed repair order with all related data
   */
  async getRepairOrderDetails(repairOrderId) {
    const client = await this.pool.connect();

    try {
      // Get repair order with customer and vehicle
      const roQuery = `
        SELECT ro.*,
               c.full_name as customer_name, c.email as customer_email, c.phone as customer_phone,
               v.vin, v.year, v.make, v.model, v.plate, v.mileage
        FROM repair_orders ro
        JOIN customers c ON ro.customer_id = c.id
        JOIN vehicles v ON ro.vehicle_id = v.id
        WHERE ro.id = $1
      `;

      const roResult = await client.query(roQuery, [repairOrderId]);
      if (roResult.rows.length === 0) {
        return null;
      }

      const repairOrder = roResult.rows[0];

      // Get parts lines
      const partsResult = await client.query(
        'SELECT * FROM ro_parts_lines WHERE repair_order_id = $1 ORDER BY created_at',
        [repairOrderId]
      );

      // Get labor lines
      const laborResult = await client.query(
        'SELECT * FROM ro_labor_lines WHERE repair_order_id = $1 ORDER BY created_at',
        [repairOrderId]
      );

      // Get time entries
      const timeResult = await client.query(
        'SELECT te.*, u.name as technician_name FROM time_entries te JOIN users u ON te.technician_id = u.id WHERE te.repair_order_id = $1 ORDER BY te.start_time DESC',
        [repairOrderId]
      );

      // Get feedback
      const feedbackResult = await client.query(
        'SELECT * FROM repair_order_feedback WHERE repair_order_id = $1',
        [repairOrderId]
      );

      return {
        ...repairOrder,
        parts: partsResult.rows,
        labor: laborResult.rows,
        timeEntries: timeResult.rows,
        feedback: feedbackResult.rows
      };

    } finally {
      client.release();
    }
  }
}

module.exports = RepairOrderService;