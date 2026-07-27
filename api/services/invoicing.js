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
 * Invoicing Service
 * Invoices derived from repair orders, and the payments recorded against them.
 *
 * Argument order is (id..., data, workspaceId, actorId) to match how the routes
 * call the other services. Every statement is scoped by workspace_id -- an id
 * from the request is never trusted to imply its tenant.
 *
 * Lifecycle:
 *
 *   draft ──issue──> issued ──payment──> partially_paid ──payment──> paid
 *     │                 │
 *     └──── void ───────┘   (only while no payment exists)
 *
 * `subtotal` is snapshotted from the order's labour and parts lines when the
 * invoice is created, and re-snapshotted on issue. After that it is frozen:
 * editing a line on an issued invoice must not restate what the customer was
 * billed. Corrections are a void plus a new invoice, which is also what leaves a
 * usable audit trail.
 */

const VALID_METHODS = ['cash', 'check', 'card', 'ach', 'other'];

/* Statuses that can still accept money. 'draft' cannot: nothing has been sent to
   the customer yet, so a payment against it would have no counterpart. */
const PAYABLE = ['issued', 'partially_paid'];

class InvoicingService {
  constructor(pool) {
    this.pool = pool;
  }

  /** Round to cents. Money arithmetic in JS floats drifts; every write goes through here. */
  static money(value) {
    return Number(Number(value).toFixed(2));
  }

  /**
   * Next invoice number for a workspace: INV-<year>-<sequence>.
   *
   * Derived from the workspace's existing numbers inside the caller's
   * transaction, the same approach repair-order.js uses for ro_number after a
   * `RO-${Date.now()}` scheme collided under concurrent creates. The sequence is
   * per workspace and per year, so tenants never see each other's volume.
   */
  async nextInvoiceNumber(client, workspaceId) {
    const year = new Date().getUTCFullYear();
    const prefix = `INV-${year}-`;
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(invoice_number, '^' || $2, '', ''), '')::bigint), 1000) AS max_seq
         FROM invoices
        WHERE workspace_id = $1 AND invoice_number ~ ('^' || $2 || '[0-9]+$')`,
      [workspaceId, prefix]
    );
    return `${prefix}${Number(rows[0].max_seq) + 1}`;
  }

  /**
   * Sum the order's billable lines. Returns cents-rounded labour, parts, subtotal.
   */
  async readOrderTotals(client, repairOrderId, workspaceId) {
    const { rows } = await client.query(
      `SELECT
         COALESCE((SELECT SUM(line_total) FROM ro_labor_lines
                    WHERE repair_order_id = $1 AND workspace_id = $2), 0) AS labor,
         COALESCE((SELECT SUM(line_total) FROM ro_parts_lines
                    WHERE repair_order_id = $1 AND workspace_id = $2), 0) AS parts`,
      [repairOrderId, workspaceId]
    );
    const labor = InvoicingService.money(rows[0].labor);
    const parts = InvoicingService.money(rows[0].parts);
    return { labor, parts, subtotal: InvoicingService.money(labor + parts) };
  }

  /** Apply a tax rate to a subtotal. */
  static applyTax(subtotal, taxRate) {
    const taxAmount = InvoicingService.money(subtotal * taxRate);
    return { taxAmount, total: InvoicingService.money(subtotal + taxAmount) };
  }

  async listInvoices(workspaceId, filters = {}) {
    const values = [workspaceId];
    const where = ['i.workspace_id = $1'];

    if (filters.status) {
      values.push(requireString(filters.status, 'status', { max: 40 }));
      where.push(`i.status = $${values.length}`);
    }
    if (filters.customerId !== undefined && filters.customerId !== null && filters.customerId !== '') {
      values.push(parseId(filters.customerId, 'customerId'));
      where.push(`i.customer_id = $${values.length}`);
    }

    const { rows } = await this.pool.query(
      `SELECT i.*, (i.total - i.amount_paid) AS balance_due,
              c.full_name AS customer_name, c.email AS customer_email,
              ro.ro_number
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id AND c.workspace_id = i.workspace_id
         JOIN repair_orders ro ON ro.id = i.repair_order_id AND ro.workspace_id = i.workspace_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC, i.id DESC`,
      values
    );
    return rows;
  }

  async getInvoice(invoiceId, workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT i.*, (i.total - i.amount_paid) AS balance_due,
              c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
              ro.ro_number, ro.status AS repair_order_status, ro.concern
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id AND c.workspace_id = i.workspace_id
         JOIN repair_orders ro ON ro.id = i.repair_order_id AND ro.workspace_id = i.workspace_id
        WHERE i.id = $1 AND i.workspace_id = $2`,
      [invoiceId, workspaceId]
    );
    if (!rows.length) throw new NotFoundError('Invoice not found.');

    const { rows: payments } = await this.pool.query(
      `SELECT p.*, u.name AS recorded_by_name
         FROM payments p
         LEFT JOIN users u ON u.id = p.recorded_by
        WHERE p.invoice_id = $1 AND p.workspace_id = $2
        ORDER BY p.received_at, p.id`,
      [invoiceId, workspaceId]
    );

    return { ...rows[0], payments };
  }

  /**
   * Create a draft invoice for a repair order.
   */
  async createInvoice(invoiceData, workspaceId, actorId) {
    const data = invoiceData || {};
    const repairOrderId = parseId(data.repairOrderId, 'repairOrderId');
    const taxRate = data.taxRate === undefined || data.taxRate === null || data.taxRate === ''
      ? 0
      : parseNumber(data.taxRate, 'taxRate', { min: 0, max: 1 });
    const notes = optionalString(data.notes);
    const dueDate = data.dueDate ? requireString(data.dueDate, 'dueDate', { max: 40 }) : null;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: orders } = await client.query(
        `SELECT id, customer_id, status FROM repair_orders
          WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [repairOrderId, workspaceId]
      );
      if (!orders.length) throw new NotFoundError('Repair order not found.');

      const order = orders[0];
      if (!order.customer_id) {
        throw new ValidationError('That repair order has no customer, so it cannot be invoiced.');
      }
      if (order.status === 'cancelled') {
        throw new ValidationError('A cancelled repair order cannot be invoiced.');
      }

      /* The unique index is the real guard against a duplicate; checking first
         lets us return a useful message instead of a constraint violation. */
      const { rows: existing } = await client.query(
        'SELECT id, invoice_number, status FROM invoices WHERE workspace_id = $1 AND repair_order_id = $2',
        [workspaceId, repairOrderId]
      );
      if (existing.length) {
        throw new ConflictError(
          `That repair order already has invoice ${existing[0].invoice_number}. Void it before issuing another.`
        );
      }

      const { subtotal } = await this.readOrderTotals(client, repairOrderId, workspaceId);
      const { taxAmount, total } = InvoicingService.applyTax(subtotal, taxRate);
      const invoiceNumber = await this.nextInvoiceNumber(client, workspaceId);

      const { rows } = await client.query(
        `INSERT INTO invoices (
           workspace_id, repair_order_id, customer_id, invoice_number, status,
           subtotal, tax_rate, tax_amount, total, due_date, notes, created_by
         ) VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [workspaceId, repairOrderId, order.customer_id, invoiceNumber,
          subtotal, taxRate, taxAmount, total, dueDate, notes, actorId || null]
      );

      await client.query('COMMIT');
      return { ...rows[0], balance_due: InvoicingService.money(total) };
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505' || e.code === '23514') {
        throw new ConflictError('That repair order already has an invoice.');
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Issue a draft invoice, re-snapshotting the order totals as of now.
   */
  async issueInvoice(invoiceId, workspaceId, _actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const invoice = await this.lockInvoice(client, invoiceId, workspaceId);
      if (invoice.status !== 'draft') {
        throw new ConflictError(`Only a draft invoice can be issued; this one is ${invoice.status}.`);
      }

      const { subtotal } = await this.readOrderTotals(client, invoice.repair_order_id, workspaceId);
      const { taxAmount, total } = InvoicingService.applyTax(subtotal, Number(invoice.tax_rate));

      const { rows } = await client.query(
        `UPDATE invoices
            SET status = 'issued', issued_at = NOW(), updated_at = NOW(),
                subtotal = $1, tax_amount = $2, total = $3
          WHERE id = $4 AND workspace_id = $5
          RETURNING *`,
        [subtotal, taxAmount, total, invoiceId, workspaceId]
      );

      await client.query('COMMIT');
      return { ...rows[0], balance_due: InvoicingService.money(total) };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Void an invoice. Refused once money has been recorded against it -- that
   * would erase the record of a payment rather than reverse it, and reversal
   * (credit notes) is deliberately not modelled.
   */
  async voidInvoice(invoiceId, voidData, workspaceId, _actorId) {
    const reason = requireString((voidData || {}).reason, 'reason', { max: 500 });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const invoice = await this.lockInvoice(client, invoiceId, workspaceId);
      if (invoice.status === 'void') throw new ConflictError('That invoice is already void.');

      const { rows: paid } = await client.query(
        'SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1 AND workspace_id = $2',
        [invoiceId, workspaceId]
      );
      if (paid[0].n > 0) {
        throw new ConflictError(
          'That invoice has payments recorded against it and cannot be voided. Reverse the payments first.'
        );
      }

      const { rows } = await client.query(
        `UPDATE invoices
            SET status = 'void', voided_at = NOW(), void_reason = $1, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3
          RETURNING *`,
        [reason, invoiceId, workspaceId]
      );

      await client.query('COMMIT');
      return { ...rows[0], balance_due: 0 };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Record a payment and advance the invoice's status.
   */
  async recordPayment(invoiceId, paymentData, workspaceId, actorId) {
    const data = paymentData || {};
    const amount = parseNumber(data.amount, 'amount', { min: 0.01 });
    const method = requireString(data.method, 'method', { max: 20 }).toLowerCase();
    const reference = optionalString(data.reference, { max: 200 });
    const notes = optionalString(data.notes);
    const receivedAt = data.receivedAt ? requireString(data.receivedAt, 'receivedAt', { max: 40 }) : null;

    if (!VALID_METHODS.includes(method)) {
      throw new ValidationError(`method must be one of: ${VALID_METHODS.join(', ')}.`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      /* FOR UPDATE on the invoice row serialises concurrent payments, so two
         clients cannot each read the same amount_paid and both post. */
      const invoice = await this.lockInvoice(client, invoiceId, workspaceId);

      if (!PAYABLE.includes(invoice.status)) {
        throw new ConflictError(
          invoice.status === 'draft'
            ? 'Issue the invoice before recording a payment against it.'
            : `An invoice that is ${invoice.status} cannot take further payment.`
        );
      }

      const total = InvoicingService.money(invoice.total);
      const alreadyPaid = InvoicingService.money(invoice.amount_paid);
      const balance = InvoicingService.money(total - alreadyPaid);

      if (amount > balance) {
        throw new ValidationError(
          `That payment of ${amount.toFixed(2)} exceeds the outstanding balance of ${balance.toFixed(2)}.`
        );
      }

      const { rows: payments } = await client.query(
        `INSERT INTO payments (
           workspace_id, invoice_id, amount, method, reference, notes, recorded_by, received_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, NOW()))
         RETURNING *`,
        [workspaceId, invoiceId, amount, method, reference, notes, actorId || null, receivedAt]
      );

      const newPaid = InvoicingService.money(alreadyPaid + amount);
      const settled = newPaid >= total;

      const { rows } = await client.query(
        `UPDATE invoices
            SET amount_paid = $1,
                status = $2,
                paid_at = CASE WHEN $3::boolean THEN NOW() ELSE paid_at END,
                updated_at = NOW()
          WHERE id = $4 AND workspace_id = $5
          RETURNING *`,
        [newPaid, settled ? 'paid' : 'partially_paid', settled, invoiceId, workspaceId]
      );

      await client.query('COMMIT');
      return {
        payment: payments[0],
        invoice: { ...rows[0], balance_due: InvoicingService.money(total - newPaid) },
      };
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') {
        throw new ConflictError('A payment with that reference has already been recorded.');
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /** Fetch and lock an invoice inside a transaction, scoped to its workspace. */
  async lockInvoice(client, invoiceId, workspaceId) {
    const { rows } = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [invoiceId, workspaceId]
    );
    if (!rows.length) throw new NotFoundError('Invoice not found.');
    return rows[0];
  }

  /**
   * Accounts-receivable rollup for the reports page.
   */
  async getReceivablesSummary(workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*)::int AS invoice_count,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
         COUNT(*) FILTER (WHERE status IN ('issued', 'partially_paid'))::int AS outstanding_count,
         COUNT(*) FILTER (WHERE status IN ('issued', 'partially_paid')
                            AND due_date IS NOT NULL AND due_date < CURRENT_DATE)::int AS overdue_count,
         COALESCE(SUM(total) FILTER (WHERE status <> 'void'), 0) AS billed_total,
         COALESCE(SUM(amount_paid) FILTER (WHERE status <> 'void'), 0) AS collected_total,
         COALESCE(SUM(total - amount_paid) FILTER (WHERE status IN ('issued', 'partially_paid')), 0) AS outstanding_total
       FROM invoices
      WHERE workspace_id = $1`,
      [workspaceId]
    );
    return rows[0];
  }
}

module.exports = InvoicingService;
module.exports.VALID_METHODS = VALID_METHODS;
