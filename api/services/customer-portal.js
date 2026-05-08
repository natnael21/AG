const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/**
 * Customer Portal Service
 * Handles customer authentication, service history, and appointment scheduling
 */

class CustomerPortalService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Customer login
   */
  async customerLogin(email, password, workspaceId) {
    // Find customer by email
    const customerResult = await this.pool.query(
      'SELECT * FROM customers WHERE lower(email) = lower($1) AND workspace_id = $2',
      [email, workspaceId]
    );

    if (customerResult.rows.length === 0) {
      throw new Error('Invalid email or password');
    }

    const customer = customerResult.rows[0];

    // Check if customer has a portal password set
    if (!customer.portal_password_hash) {
      throw new Error('Portal access not enabled. Please contact the shop.');
    }

    // Verify password
    const isValid = await bcrypt.compare(password, customer.portal_password_hash);
    if (!isValid) {
      throw new Error('Invalid email or password');
    }

    // Update last login
    await this.pool.query(
      'UPDATE customers SET last_portal_login = NOW() WHERE id = $1',
      [customer.id]
    );

    // Generate session token
    const sessionToken = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await this.pool.query(
      'INSERT INTO customer_sessions (customer_id, session_token, expires_at) VALUES ($1, $2, $3)',
      [customer.id, sessionToken, expiresAt]
    );

    return {
      customer: {
        id: customer.id,
        full_name: customer.full_name,
        email: customer.email,
        phone: customer.phone,
        last_portal_login: customer.last_portal_login
      },
      sessionToken
    };
  }

  /**
   * Enable customer portal access
   */
  async enablePortalAccess(customerId, tempPassword) {
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const result = await this.pool.query(
      'UPDATE customers SET portal_password_hash = $1, portal_enabled = true WHERE id = $2 RETURNING *',
      [passwordHash, customerId]
    );

    if (result.rows.length === 0) {
      throw new Error('Customer not found');
    }

    return { customer: result.rows[0], tempPassword };
  }

  /**
   * Reset customer portal password
   */
  async resetPortalPassword(customerId) {
    const tempPassword = this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const result = await this.pool.query(
      'UPDATE customers SET portal_password_hash = $1 WHERE id = $2 RETURNING *',
      [passwordHash, customerId]
    );

    if (result.rows.length === 0) {
      throw new Error('Customer not found');
    }

    return { customer: result.rows[0], tempPassword };
  }

  /**
   * Update customer portal password
   */
  async updatePortalPassword(customerId, currentPassword, newPassword) {
    // Get customer
    const customerResult = await this.pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customerId]
    );

    if (customerResult.rows.length === 0) {
      throw new Error('Customer not found');
    }

    const customer = customerResult.rows[0];

    if (!customer.portal_password_hash) {
      throw new Error('Portal access not enabled');
    }

    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, customer.portal_password_hash);
    if (!isValid) {
      throw new Error('Current password is incorrect');
    }

    // Hash new password
    const newHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await this.pool.query(
      'UPDATE customers SET portal_password_hash = $1 WHERE id = $2',
      [newHash, customerId]
    );

    return { success: true };
  }

  /**
   * Get customer service history
   */
  async getServiceHistory(customerId, limit = 50, offset = 0) {
    const query = `
      SELECT
        ro.id, ro.ro_number, ro.status, ro.concern, ro.priority,
        ro.total_estimate, ro.total_final, ro.created_at, ro.actual_completion,
        ro.estimated_completion, ro.notes,
        v.year, v.make, v.model, v.license_plate,
        json_agg(
          json_build_object(
            'description', rll.description,
            'technician_name', rll.technician_name,
            'hours', rll.hours,
            'line_total', rll.line_total
          )
        ) FILTER (WHERE rll.id IS NOT NULL) as labor_lines,
        json_agg(
          json_build_object(
            'part_number', rpl.part_number,
            'part_name', rpl.part_name,
            'quantity', rpl.quantity,
            'line_total', rpl.line_total
          )
        ) FILTER (WHERE rpl.id IS NOT NULL) as parts_lines
      FROM repair_orders ro
      JOIN vehicles v ON ro.vehicle_id = v.id
      LEFT JOIN ro_labor_lines rll ON ro.id = rll.repair_order_id
      LEFT JOIN ro_parts_lines rpl ON ro.id = rpl.repair_order_id
      WHERE ro.customer_id = $1
      GROUP BY ro.id, ro.ro_number, ro.status, ro.concern, ro.priority,
               ro.total_estimate, ro.total_final, ro.created_at, ro.actual_completion,
               ro.estimated_completion, ro.notes, v.year, v.make, v.model, v.license_plate
      ORDER BY ro.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await this.pool.query(query, [customerId, limit, offset]);
    return result.rows;
  }

  /**
   * Get customer vehicles
   */
  async getCustomerVehicles(customerId) {
    const query = `
      SELECT
        v.*,
        COUNT(ro.id) as total_repair_orders,
        MAX(ro.created_at) as last_service_date,
        SUM(ro.total_final) as total_spent
      FROM vehicles v
      LEFT JOIN repair_orders ro ON v.id = ro.vehicle_id
      WHERE v.customer_id = $1
      GROUP BY v.id
      ORDER BY v.created_at DESC
    `;

    const result = await this.pool.query(query, [customerId]);
    return result.rows;
  }

  /**
   * Schedule appointment
   */
  async scheduleAppointment(customerId, appointmentData) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const {
        vehicleId,
        preferredDate,
        preferredTime,
        concern,
        contactMethod = 'email',
        notes
      } = appointmentData;

      // Validate vehicle belongs to customer
      const vehicleResult = await client.query(
        'SELECT * FROM vehicles WHERE id = $1 AND customer_id = $2',
        [vehicleId, customerId]
      );

      if (vehicleResult.rows.length === 0) {
        throw new Error('Vehicle not found or does not belong to customer');
      }

      // Create appointment
      const insertQuery = `
        INSERT INTO appointments (
          customer_id, vehicle_id, preferred_date, preferred_time,
          concern, contact_method, notes, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
        RETURNING *
      `;

      const values = [
        customerId, vehicleId, preferredDate, preferredTime,
        concern, contactMethod, notes
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
   * Get customer appointments
   */
  async getCustomerAppointments(customerId, status = null) {
    let query = `
      SELECT
        a.*,
        v.year, v.make, v.model, v.license_plate
      FROM appointments a
      JOIN vehicles v ON a.vehicle_id = v.id
      WHERE a.customer_id = $1
    `;

    const params = [customerId];

    if (status) {
      query += ' AND a.status = $2';
      params.push(status);
    }

    query += ' ORDER BY a.preferred_date DESC, a.preferred_time DESC';

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Update appointment
   */
  async updateAppointment(appointmentId, customerId, updateData) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Verify appointment belongs to customer
      const appointmentResult = await client.query(
        'SELECT * FROM appointments WHERE id = $1 AND customer_id = $2',
        [appointmentId, customerId]
      );

      if (appointmentResult.rows.length === 0) {
        throw new Error('Appointment not found or does not belong to customer');
      }

      const appointment = appointmentResult.rows[0];

      // Only allow updates for pending appointments
      if (appointment.status !== 'pending') {
        throw new Error('Cannot update appointment that is not pending');
      }

      const { preferredDate, preferredTime, concern, notes } = updateData;
      const updates = {};
      const values = [];
      let paramCount = 1;

      if (preferredDate !== undefined) {
        updates.preferred_date = `$${paramCount++}`;
        values.push(preferredDate);
      }

      if (preferredTime !== undefined) {
        updates.preferred_time = `$${paramCount++}`;
        values.push(preferredTime);
      }

      if (concern !== undefined) {
        updates.concern = `$${paramCount++}`;
        values.push(concern);
      }

      if (notes !== undefined) {
        updates.notes = `$${paramCount++}`;
        values.push(notes);
      }

      if (Object.keys(updates).length === 0) {
        throw new Error('No fields to update');
      }

      updates.updated_at = 'NOW()';

      const updateQuery = `
        UPDATE appointments
        SET ${Object.keys(updates).map(key => `${key} = ${updates[key]}`).join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;

      values.push(appointmentId);

      const result = await client.query(updateQuery, values);

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
   * Cancel appointment
   */
  async cancelAppointment(appointmentId, customerId) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Verify appointment belongs to customer and is cancellable
      const appointmentResult = await client.query(
        'SELECT * FROM appointments WHERE id = $1 AND customer_id = $2',
        [appointmentId, customerId]
      );

      if (appointmentResult.rows.length === 0) {
        throw new Error('Appointment not found or does not belong to customer');
      }

      const appointment = appointmentResult.rows[0];

      if (!['pending', 'confirmed'].includes(appointment.status)) {
        throw new Error('Cannot cancel appointment with current status');
      }

      // Update status to cancelled
      const result = await client.query(
        'UPDATE appointments SET status = \'cancelled\', updated_at = NOW() WHERE id = $1 RETURNING *',
        [appointmentId]
      );

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
   * Get customer profile
   */
  async getCustomerProfile(customerId) {
    const query = `
      SELECT
        c.id, c.full_name, c.email, c.phone, c.address, c.city, c.state, c.zip_code,
        c.created_at, c.last_portal_login, c.portal_enabled,
        COUNT(DISTINCT v.id) as total_vehicles,
        COUNT(DISTINCT ro.id) as total_repair_orders,
        COALESCE(SUM(ro.total_final), 0) as total_spent,
        MAX(ro.created_at) as last_service_date
      FROM customers c
      LEFT JOIN vehicles v ON c.id = v.customer_id
      LEFT JOIN repair_orders ro ON c.id = ro.customer_id
      WHERE c.id = $1
      GROUP BY c.id, c.full_name, c.email, c.phone, c.address, c.city, c.state, c.zip_code,
               c.created_at, c.last_portal_login, c.portal_enabled
    `;

    const result = await this.pool.query(query, [customerId]);

    if (result.rows.length === 0) {
      throw new Error('Customer not found');
    }

    return result.rows[0];
  }

  /**
   * Update customer profile
   */
  async updateCustomerProfile(customerId, profileData) {
    const { full_name, phone, address, city, state, zip_code } = profileData;

    const updates = {};
    const values = [];
    let paramCount = 1;

    if (full_name !== undefined) {
      updates.full_name = `$${paramCount++}`;
      values.push(full_name);
    }

    if (phone !== undefined) {
      updates.phone = `$${paramCount++}`;
      values.push(phone);
    }

    if (address !== undefined) {
      updates.address = `$${paramCount++}`;
      values.push(address);
    }

    if (city !== undefined) {
      updates.city = `$${paramCount++}`;
      values.push(city);
    }

    if (state !== undefined) {
      updates.state = `$${paramCount++}`;
      values.push(state);
    }

    if (zip_code !== undefined) {
      updates.zip_code = `$${paramCount++}`;
      values.push(zip_code);
    }

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update');
    }

    updates.updated_at = 'NOW()';

    const updateQuery = `
      UPDATE customers
      SET ${Object.keys(updates).map(key => `${key} = ${updates[key]}`).join(', ')}
      WHERE id = $${paramCount}
      RETURNING id, full_name, email, phone, address, city, state, zip_code, updated_at
    `;

    values.push(customerId);

    const result = await this.pool.query(updateQuery, values);

    if (result.rows.length === 0) {
      throw new Error('Customer not found');
    }

    return result.rows[0];
  }

  /**
   * Validate customer session
   */
  async validateSession(sessionToken) {
    const result = await this.pool.query(
      'SELECT c.* FROM customer_sessions cs JOIN customers c ON cs.customer_id = c.id WHERE cs.session_token = $1 AND cs.expires_at > NOW()',
      [sessionToken]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  /**
   * Logout customer (invalidate session)
   */
  async logout(sessionToken) {
    await this.pool.query(
      'DELETE FROM customer_sessions WHERE session_token = $1',
      [sessionToken]
    );

    return { success: true };
  }

  /**
   * Generate temporary password
   */
  generateTempPassword() {
    return `Portal-${uuidv4().slice(0, 8)}!`;
  }
}

module.exports = CustomerPortalService;