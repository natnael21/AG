/**
 * Parts Management Service
 * Handles parts catalog, inventory, and stock management
 */

class PartsService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Create a new part in the catalog
   */
  async createPart(workspaceId, partData) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const {
        partNumber,
        name,
        description,
        category,
        manufacturer,
        costPrice,
        retailPrice,
        quantityOnHand = 0,
        minimumStock = 0,
        location
      } = partData;

      if (!partNumber || !name) {
        throw new Error('partNumber and name are required');
      }

      // Check for duplicate part number in workspace
      const duplicateCheck = await client.query(
        'SELECT id FROM parts WHERE workspace_id = $1 AND part_number = $2',
        [workspaceId, partNumber]
      );

      if (duplicateCheck.rows.length > 0) {
        throw new Error('Part number already exists in this workspace');
      }

      const insertQuery = `
        INSERT INTO parts (
          workspace_id, part_number, name, description, category,
          manufacturer, cost_price, retail_price, quantity_on_hand,
          minimum_stock, location
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `;

      const values = [
        workspaceId, partNumber, name, description, category,
        manufacturer, costPrice, retailPrice, quantityOnHand,
        minimumStock, location
      ];

      const result = await client.query(insertQuery, values);

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
   * Update part information
   */
  async updatePart(partId, workspaceId, updateData) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Build dynamic update query
      const fields = [];
      const values = [];
      let paramCount = 1;

      Object.keys(updateData).forEach(key => {
        if (updateData[key] !== undefined) {
          fields.push(`${key} = $${paramCount++}`);
          values.push(updateData[key]);
        }
      });

      if (fields.length === 0) {
        throw new Error('No fields to update');
      }

      fields.push(`updated_at = NOW()`);

      const updateQuery = `
        UPDATE parts
        SET ${fields.join(', ')}
        WHERE id = $${paramCount} AND workspace_id = $${paramCount + 1}
        RETURNING *
      `;

      values.push(partId, workspaceId);

      const result = await client.query(updateQuery, values);

      if (result.rows.length === 0) {
        throw new Error('Part not found');
      }

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
   * Adjust inventory quantity
   */
  async adjustInventory(partId, workspaceId, adjustment, reason, performedBy) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Get current quantity
      const currentResult = await client.query(
        'SELECT quantity_on_hand, name FROM parts WHERE id = $1 AND workspace_id = $2',
        [partId, workspaceId]
      );

      if (currentResult.rows.length === 0) {
        throw new Error('Part not found');
      }

      const currentQuantity = currentResult.rows[0].quantity_on_hand;
      const newQuantity = currentQuantity + adjustment;

      if (newQuantity < 0) {
        throw new Error('Cannot reduce inventory below zero');
      }

      // Update quantity
      const updateResult = await client.query(
        'UPDATE parts SET quantity_on_hand = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [newQuantity, partId]
      );

      // Log inventory adjustment (you might want to create an inventory_log table)
      console.log(`[Inventory] ${reason}: ${currentResult.rows[0].name} (${currentQuantity} → ${newQuantity}) by user ${performedBy}`);

      await client.query('COMMIT');
      return updateResult.rows[0];

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get parts with low stock alerts
   */
  async getLowStockParts(workspaceId) {
    const query = `
      SELECT *,
             (quantity_on_hand <= minimum_stock) as is_low_stock,
             (quantity_on_hand - minimum_stock) as stock_deficit
      FROM parts
      WHERE workspace_id = $1
        AND active = true
        AND quantity_on_hand <= minimum_stock
      ORDER BY (quantity_on_hand - minimum_stock) ASC
    `;

    const result = await this.pool.query(query, [workspaceId]);
    return result.rows;
  }

  /**
   * Search parts by various criteria
   */
  async searchParts(workspaceId, searchCriteria) {
    const { query, category, manufacturer, inStockOnly = false } = searchCriteria;

    let sql = `
      SELECT * FROM parts
      WHERE workspace_id = $1 AND active = true
    `;
    const params = [workspaceId];
    let paramCount = 2;

    if (query) {
      sql += ` AND (part_number ILIKE $${paramCount} OR name ILIKE $${paramCount} OR description ILIKE $${paramCount})`;
      params.push(`%${query}%`);
      paramCount++;
    }

    if (category) {
      sql += ` AND category = $${paramCount}`;
      params.push(category);
      paramCount++;
    }

    if (manufacturer) {
      sql += ` AND manufacturer = $${paramCount}`;
      params.push(manufacturer);
      paramCount++;
    }

    if (inStockOnly) {
      sql += ` AND quantity_on_hand > 0`;
    }

    sql += ` ORDER BY name`;

    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  /**
   * Get part usage statistics
   */
  async getPartUsageStats(partId, workspaceId, dateRange = {}) {
    const { startDate, endDate } = dateRange;

    let dateFilter = '';
    const params = [partId, workspaceId];
    let paramCount = 3;

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
        COUNT(DISTINCT ro.id) as total_repair_orders,
        SUM(rpl.quantity) as total_quantity_used,
        AVG(rpl.unit_price) as avg_price,
        SUM(rpl.line_total) as total_revenue
      FROM ro_parts_lines rpl
      JOIN repair_orders ro ON rpl.repair_order_id = ro.id
      WHERE rpl.part_id = $1 AND ro.workspace_id = $2 ${dateFilter}
    `;

    const result = await this.pool.query(query, params);
    return result.rows[0] || {
      total_repair_orders: 0,
      total_quantity_used: 0,
      avg_price: 0,
      total_revenue: 0
    };
  }

  /**
   * Bulk import parts from CSV data
   */
  async bulkImportParts(workspaceId, partsData, performedBy) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const results = {
        success: 0,
        errors: [],
        duplicates: []
      };

      for (const partData of partsData) {
        try {
          // Check for duplicate part number
          const duplicateCheck = await client.query(
            'SELECT id FROM parts WHERE workspace_id = $1 AND part_number = $2',
            [workspaceId, partData.partNumber]
          );

          if (duplicateCheck.rows.length > 0) {
            results.duplicates.push({
              partNumber: partData.partNumber,
              reason: 'Part number already exists'
            });
            continue;
          }

          // Create part
          const part = await this.createPart(workspaceId, partData);
          results.success++;

        } catch (error) {
          results.errors.push({
            partNumber: partData.partNumber,
            error: error.message
          });
        }
      }

      await client.query('COMMIT');
      return results;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = PartsService;