const bcrypt = require('bcrypt');
const crypto = require('crypto');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
  AppError,
  parseId,
  requireString,
  optionalString,
} = require('./errors');

/**
 * Customer Portal Service
 * Handles customer authentication, service history, and appointment scheduling.
 *
 * A portal session authenticates one customer row. Every read and write here
 * is keyed by that customer's id, so a customer can only ever reach their own
 * records. The customer's workspace comes from the row itself and is never
 * taken from the request.
 */

const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'];
const CONTACT_METHODS = ['email', 'phone', 'text'];

/* Profile fields a customer may edit. Fixed list -> fixed assignments. */
const PROFILE_FIELDS = {
  full_name: (v) => requireString(v, 'full_name', { max: 200 }),
  phone:     (v) => optionalString(v, { max: 40 }),
  address:   (v) => optionalString(v, { max: 300 }),
  city:      (v) => optionalString(v, { max: 120 }),
  state:     (v) => optionalString(v, { max: 60 }),
  zip_code:  (v) => optionalString(v, { max: 20 }),
};

const APPOINTMENT_FIELDS = {
  preferredDate: { column: 'preferred_date', parse: (v) => parseFutureDate(v) },
  preferredTime: { column: 'preferred_time', parse: (v) => parseTimeOrNull(v) },
  concern:       { column: 'concern',        parse: (v) => requireString(v, 'concern') },
  notes:         { column: 'notes',          parse: (v) => optionalString(v) },
};

function parseFutureDate(value) {
  const s = requireString(value, 'preferredDate');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ValidationError('preferredDate must be in YYYY-MM-DD format.');
  }
  const date = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new ValidationError('preferredDate is not a valid date.');

  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (date.getTime() < todayUtc) throw new ValidationError('preferredDate cannot be in the past.');
  return s;
}

function parseTimeOrNull(value) {
  const s = optionalString(value, { max: 8 });
  if (!s) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s)) {
    throw new ValidationError('preferredTime must be in HH:MM format.');
  }
  return s;
}

/** Password policy for portal accounts. */
function assertPasswordStrength(password) {
  const p = String(password || '');
  if (p.length < 8) throw new ValidationError('Password must be at least 8 characters.');
  if (p.length > 200) throw new ValidationError('Password is too long.');
}

class CustomerPortalService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Authenticate a customer within a workspace and open a session.
   *
   * Failures are deliberately indistinguishable ("Invalid email or password")
   * so the portal cannot be used to enumerate which emails exist, or which of
   * them have portal access.
   */
  async customerLogin(email, password, workspaceId) {
    const genericFailure = new AppError('Invalid email or password.', 401);

    const { rows } = await this.pool.query(
      'SELECT * FROM customers WHERE lower(email) = lower($1) AND workspace_id = $2',
      [String(email || '').trim(), workspaceId]
    );

    const customer = rows[0];
    if (!customer || !customer.portal_password_hash || customer.portal_enabled !== true) {
      /* Spend comparable time either way so a missing account is not
         detectable from how quickly the request comes back. */
      await bcrypt.compare(String(password || ''), '$2b$12$............................................');
      throw genericFailure;
    }

    const isValid = await bcrypt.compare(String(password || ''), customer.portal_password_hash);
    if (!isValid) throw genericFailure;

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE customers SET last_portal_login = NOW() WHERE id = $1', [customer.id]);
      await client.query('DELETE FROM customer_sessions WHERE expires_at < NOW()');
      await client.query(
        'INSERT INTO customer_sessions (customer_id, session_token, expires_at) VALUES ($1,$2,$3)',
        [customer.id, sessionToken, expiresAt]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return {
      customer: {
        id: customer.id,
        workspace_id: customer.workspace_id,
        full_name: customer.full_name,
        email: customer.email,
        phone: customer.phone,
        last_portal_login: customer.last_portal_login,
      },
      sessionToken,
      expiresAt,
    };
  }

  /**
   * Enable portal access for a customer in this workspace.
   */
  async enablePortalAccess(customerId, tempPassword, workspaceId) {
    assertPasswordStrength(tempPassword);
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const { rows } = await this.pool.query(
      `UPDATE customers
          SET portal_password_hash = $1, portal_enabled = true, updated_at = NOW()
        WHERE id = $2 AND workspace_id = $3
        RETURNING id, workspace_id, full_name, email, phone, portal_enabled`,
      [passwordHash, customerId, workspaceId]
    );
    if (!rows.length) throw new NotFoundError('Customer not found.');
    if (!rows[0].email) {
      throw new ValidationError('This customer has no email address, so they cannot sign in to the portal.');
    }

    return { customer: rows[0], tempPassword };
  }

  /**
   * Issue a fresh temporary password and invalidate existing sessions.
   */
  async resetPortalPassword(customerId, workspaceId) {
    const tempPassword = this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE customers
            SET portal_password_hash = $1, portal_enabled = true, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3
          RETURNING id, workspace_id, full_name, email, portal_enabled`,
        [passwordHash, customerId, workspaceId]
      );
      if (!rows.length) throw new NotFoundError('Customer not found.');

      await client.query('DELETE FROM customer_sessions WHERE customer_id = $1', [customerId]);
      await client.query('COMMIT');
      return { customer: rows[0], tempPassword };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Change the signed-in customer's own password.
   */
  async updatePortalPassword(customerId, currentPassword, newPassword) {
    assertPasswordStrength(newPassword);

    const { rows } = await this.pool.query('SELECT * FROM customers WHERE id = $1', [customerId]);
    if (!rows.length) throw new NotFoundError('Customer not found.');

    const customer = rows[0];
    if (!customer.portal_password_hash) throw new ValidationError('Portal access is not enabled.');

    const isValid = await bcrypt.compare(String(currentPassword || ''), customer.portal_password_hash);
    if (!isValid) throw new ValidationError('Current password is incorrect.');

    const newHash = await bcrypt.hash(newPassword, 12);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE customers SET portal_password_hash = $1, updated_at = NOW() WHERE id = $2',
        [newHash, customerId]
      );
      /* Force other devices to sign in again. */
      await client.query('DELETE FROM customer_sessions WHERE customer_id = $1', [customerId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return { success: true };
  }

  /**
   * The customer's repair order history, newest first.
   */
  async getServiceHistory(customerId, limit = 50, offset = 0) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const { rows } = await this.pool.query(
      `SELECT
         ro.id, ro.ro_number, ro.status, ro.concern, ro.priority,
         ro.total_estimate, ro.total_final, ro.created_at, ro.actual_completion,
         ro.estimated_completion, ro.notes,
         v.id AS vehicle_id, v.year, v.make, v.model, v.plate,
         (SELECT json_agg(json_build_object(
                   'description', l.description,
                   'technician_name', l.technician_name,
                   'hours', l.hours,
                   'line_total', l.line_total) ORDER BY l.id)
            FROM ro_labor_lines l WHERE l.repair_order_id = ro.id) AS labor_lines,
         (SELECT json_agg(json_build_object(
                   'part_number', p.part_number,
                   'part_name', p.part_name,
                   'quantity', p.quantity,
                   'line_total', p.line_total) ORDER BY p.id)
            FROM ro_parts_lines p WHERE p.repair_order_id = ro.id) AS parts_lines,
         (SELECT json_build_object('rating', f.rating, 'comments', f.comments, 'created_at', f.created_at)
            FROM feedback f
           WHERE f.repair_order_id = ro.id AND f.customer_id = ro.customer_id
           LIMIT 1) AS feedback
       FROM repair_orders ro
       JOIN vehicles v ON ro.vehicle_id = v.id
      WHERE ro.customer_id = $1
      ORDER BY ro.created_at DESC
      LIMIT $2 OFFSET $3`,
      [customerId, safeLimit, safeOffset]
    );

    return rows;
  }

  /**
   * The customer's vehicles with service roll-ups.
   */
  async getCustomerVehicles(customerId) {
    const { rows } = await this.pool.query(
      `SELECT
         v.id, v.vin, v.year, v.make, v.model, v.plate, v.mileage, v.created_at,
         COUNT(ro.id)                     AS total_repair_orders,
         MAX(ro.created_at)               AS last_service_date,
         COALESCE(SUM(ro.total_final), 0) AS total_spent
       FROM vehicles v
       LEFT JOIN repair_orders ro ON v.id = ro.vehicle_id
      WHERE v.customer_id = $1
      GROUP BY v.id
      ORDER BY v.created_at DESC`,
      [customerId]
    );
    return rows;
  }

  /**
   * Book an appointment against one of the customer's own vehicles.
   */
  async scheduleAppointment(customerId, appointmentData) {
    const data = appointmentData || {};
    const vehicleId = parseId(data.vehicleId, 'vehicleId');
    const preferredDate = parseFutureDate(data.preferredDate);
    const preferredTime = parseTimeOrNull(data.preferredTime);
    const concern = requireString(data.concern, 'concern');
    const notes = optionalString(data.notes);
    const contactMethod = data.contactMethod || 'email';

    if (!CONTACT_METHODS.includes(contactMethod)) {
      throw new ValidationError(`contactMethod must be one of: ${CONTACT_METHODS.join(', ')}.`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      /* The vehicle must belong to this customer; workspace_id is taken from
         the customer row, never from the request. */
      const { rows: owned } = await client.query(
        `SELECT v.id, c.workspace_id
           FROM vehicles v
           JOIN customers c ON c.id = v.customer_id
          WHERE v.id = $1 AND v.customer_id = $2`,
        [vehicleId, customerId]
      );
      if (!owned.length) throw new NotFoundError('Vehicle not found.');

      /* Treat a repeat booking for the same vehicle, date and concern as the
         same request rather than creating a duplicate. */
      const { rows: existing } = await client.query(
        `SELECT * FROM appointments
          WHERE customer_id = $1 AND vehicle_id = $2 AND preferred_date = $3
            AND status = 'pending' AND lower(concern) = lower($4)
          LIMIT 1`,
        [customerId, vehicleId, preferredDate, concern]
      );
      if (existing.length) {
        await client.query('COMMIT');
        return existing[0];
      }

      const { rows } = await client.query(
        `INSERT INTO appointments (
           workspace_id, customer_id, vehicle_id, preferred_date, preferred_time,
           concern, contact_method, notes, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
         RETURNING *`,
        [owned[0].workspace_id, customerId, vehicleId, preferredDate, preferredTime, concern, contactMethod, notes]
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
   * The customer's appointments, optionally filtered by status.
   */
  async getCustomerAppointments(customerId, status = null) {
    const params = [customerId];
    let sql = `
      SELECT a.*, v.year, v.make, v.model, v.plate
        FROM appointments a
        JOIN vehicles v ON a.vehicle_id = v.id
       WHERE a.customer_id = $1
    `;

    if (status) {
      if (!APPOINTMENT_STATUSES.includes(status)) {
        throw new ValidationError(`status must be one of: ${APPOINTMENT_STATUSES.join(', ')}.`);
      }
      params.push(status);
      sql += ` AND a.status = $${params.length}`;
    }

    sql += ' ORDER BY a.preferred_date DESC, a.preferred_time DESC NULLS LAST';

    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  /**
   * Edit a pending appointment the customer owns.
   */
  async updateAppointment(appointmentId, customerId, updateData) {
    const sets = [];
    const values = [];

    Object.entries(updateData || {}).forEach(([key, value]) => {
      const field = APPOINTMENT_FIELDS[key];
      if (!field || value === undefined) return;
      values.push(field.parse(value));
      sets.push(`${field.column} = $${values.length}`);
    });

    if (!sets.length) throw new ValidationError('No updatable fields supplied.');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: existing } = await client.query(
        'SELECT * FROM appointments WHERE id = $1 AND customer_id = $2 FOR UPDATE',
        [appointmentId, customerId]
      );
      if (!existing.length) throw new NotFoundError('Appointment not found.');
      if (existing[0].status !== 'pending') {
        throw new ConflictError('Only pending appointments can be changed. Please contact the shop.');
      }

      values.push(appointmentId, customerId);
      const { rows } = await client.query(
        `UPDATE appointments
            SET ${sets.join(', ')}
          WHERE id = $${values.length - 1} AND customer_id = $${values.length}
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
   * Cancel a pending or confirmed appointment the customer owns.
   */
  async cancelAppointment(appointmentId, customerId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: existing } = await client.query(
        'SELECT * FROM appointments WHERE id = $1 AND customer_id = $2 FOR UPDATE',
        [appointmentId, customerId]
      );
      if (!existing.length) throw new NotFoundError('Appointment not found.');

      if (existing[0].status === 'cancelled') {
        await client.query('COMMIT');
        return existing[0];
      }
      if (!['pending', 'confirmed'].includes(existing[0].status)) {
        throw new ConflictError('This appointment can no longer be cancelled. Please contact the shop.');
      }

      const { rows } = await client.query(
        `UPDATE appointments SET status = 'cancelled' WHERE id = $1 RETURNING *`,
        [appointmentId]
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
   * Leave feedback on one of the customer's own completed repair orders.
   */
  async submitFeedback(customerId, repairOrderId, { rating, comments, feedbackType = 'repair_order' } = {}) {
    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      throw new ValidationError('rating must be a whole number from 1 to 5.');
    }
    if (!['repair_order', 'appointment', 'general'].includes(feedbackType)) {
      throw new ValidationError('feedbackType is not valid.');
    }

    const { rows: owned } = await this.pool.query(
      `SELECT ro.id, ro.status, ro.workspace_id
         FROM repair_orders ro
        WHERE ro.id = $1 AND ro.customer_id = $2`,
      [repairOrderId, customerId]
    );
    if (!owned.length) throw new NotFoundError('Repair order not found.');
    if (owned[0].status !== 'completed') {
      throw new ConflictError('You can leave feedback once the work is complete.');
    }

    try {
      const { rows } = await this.pool.query(
        `INSERT INTO feedback (workspace_id, repair_order_id, customer_id, rating, comments, feedback_type)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [owned[0].workspace_id, repairOrderId, customerId, numericRating, optionalString(comments), feedbackType]
      );
      return rows[0];
    } catch (e) {
      /* Backed by idx_feedback_ro_customer. */
      if (e.code === '23505') {
        throw new ConflictError('You have already left feedback for this repair order.');
      }
      throw e;
    }
  }

  /**
   * Profile plus service roll-ups for the signed-in customer.
   */
  async getCustomerProfile(customerId) {
    const { rows } = await this.pool.query(
      `SELECT
         c.id, c.workspace_id, c.full_name, c.email, c.phone,
         c.address, c.city, c.state, c.zip_code,
         c.created_at, c.last_portal_login, c.portal_enabled,
         w.name AS workspace_name,
         (SELECT COUNT(*) FROM vehicles v WHERE v.customer_id = c.id)            AS total_vehicles,
         (SELECT COUNT(*) FROM repair_orders r WHERE r.customer_id = c.id)       AS total_repair_orders,
         (SELECT COALESCE(SUM(r.total_final),0) FROM repair_orders r WHERE r.customer_id = c.id) AS total_spent,
         (SELECT MAX(r.created_at) FROM repair_orders r WHERE r.customer_id = c.id) AS last_service_date
       FROM customers c
       LEFT JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = $1`,
      [customerId]
    );

    if (!rows.length) throw new NotFoundError('Customer not found.');
    return rows[0];
  }

  /**
   * Update the signed-in customer's own profile.
   */
  async updateCustomerProfile(customerId, profileData) {
    const sets = [];
    const values = [];

    Object.entries(profileData || {}).forEach(([key, value]) => {
      const parse = PROFILE_FIELDS[key];
      if (!parse || value === undefined) return;
      values.push(parse(value));
      sets.push(`${key} = $${values.length}`);
    });

    if (!sets.length) throw new ValidationError('No updatable fields supplied.');

    values.push(customerId);
    const { rows } = await this.pool.query(
      `UPDATE customers
          SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${values.length}
        RETURNING id, full_name, email, phone, address, city, state, zip_code, updated_at`,
      values
    );

    if (!rows.length) throw new NotFoundError('Customer not found.');
    return rows[0];
  }

  /**
   * Resolve a session token to a customer. Never returns the password hash.
   */
  async validateSession(sessionToken) {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.workspace_id, c.full_name, c.email, c.phone, c.portal_enabled
         FROM customer_sessions cs
         JOIN customers c ON cs.customer_id = c.id
        WHERE cs.session_token = $1 AND cs.expires_at > NOW()`,
      [sessionToken]
    );

    const customer = rows[0];
    if (!customer || customer.portal_enabled !== true) return null;
    return customer;
  }

  async logout(sessionToken) {
    await this.pool.query('DELETE FROM customer_sessions WHERE session_token = $1', [sessionToken]);
    return { success: true };
  }

  generateTempPassword() {
    /* 12 URL-safe characters from a CSPRNG, plus a symbol to satisfy shops
       that paste these into systems expecting mixed character classes. */
    return `Portal-${crypto.randomBytes(9).toString('base64url')}!`;
  }
}

module.exports = CustomerPortalService;
