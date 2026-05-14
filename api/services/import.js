const csv = require('csv-parser');
const { Readable } = require('stream');

function parseCSV(buffer) {
  return new Promise((resolve, reject) => {
    const rows = [];
    Readable.from(buffer.toString())
      .pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/\s+/g, '_') }))
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

class ImportService {
  constructor(pool) {
    this.pool = pool;
  }

  async importCustomers(workspaceId, buffer) {
    const rows = await parseCSV(buffer);
    const client = await this.pool.connect();
    const result = { total: rows.length, success: 0, duplicates: 0, errors: [] };

    try {
      await client.query('BEGIN');

      for (const [i, row] of rows.entries()) {
        const fullName = (row.full_name || row.name || '').trim();
        const email = (row.email || '').trim() || null;
        const phone = (row.phone || '').trim() || null;

        if (!fullName) {
          result.errors.push({ row: i + 2, reason: 'full_name is required' });
          continue;
        }

        if (email) {
          const dup = await client.query(
            'SELECT id FROM customers WHERE workspace_id = $1 AND email = $2',
            [workspaceId, email]
          );
          if (dup.rows.length > 0) {
            result.duplicates++;
            continue;
          }
        }

        await client.query(
          'INSERT INTO customers (workspace_id, full_name, email, phone) VALUES ($1,$2,$3,$4)',
          [workspaceId, fullName, email, phone]
        );
        result.success++;
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return result;
  }

  async importVehicles(workspaceId, buffer) {
    const rows = await parseCSV(buffer);
    const client = await this.pool.connect();
    const result = { total: rows.length, success: 0, duplicates: 0, errors: [] };

    try {
      await client.query('BEGIN');

      for (const [i, row] of rows.entries()) {
        const vin = (row.vin || '').trim();
        const make = (row.make || '').trim();
        const model = (row.model || '').trim();
        const year = parseInt(row.year) || null;
        const plate = (row.plate || row.license_plate || '').trim() || null;
        const mileage = parseInt(row.mileage) || null;
        const customerEmail = (row.customer_email || '').trim();

        if (!vin || !make || !model) {
          result.errors.push({ row: i + 2, reason: 'vin, make and model are required' });
          continue;
        }

        const dupVin = await client.query(
          'SELECT id FROM vehicles WHERE workspace_id = $1 AND vin = $2',
          [workspaceId, vin]
        );
        if (dupVin.rows.length > 0) {
          result.duplicates++;
          continue;
        }

        let customerId = null;
        if (customerEmail) {
          const cust = await client.query(
            'SELECT id FROM customers WHERE workspace_id = $1 AND email = $2',
            [workspaceId, customerEmail]
          );
          if (cust.rows.length > 0) customerId = cust.rows[0].id;
        }

        await client.query(
          `INSERT INTO vehicles (workspace_id, customer_id, vin, year, make, model, plate, mileage)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [workspaceId, customerId, vin, year, make, model, plate, mileage]
        );
        result.success++;
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return result;
  }
}

module.exports = ImportService;
