#!/usr/bin/env node
/**
 * Creates one workspace and one active user in it, printing a generated
 * password. Intended for standing up an empty environment far enough to log in
 * and click through the real UI -- production was rebuilt from migrations and
 * has no accounts, so without this there is no way in.
 *
 * Ids are minted the same way the application mints them (services/signup.js,
 * UserManagementService.inviteUser): workspaces.id and users.id are VARCHAR with
 * no column default, matching production, so they must be supplied on insert.
 *
 * Idempotent on email: re-running with the same --email resets that user's
 * password and re-prints it rather than failing on the unique index.
 *
 *   node scripts/seed-owner.js --email owner@example.com --shop "Demo Shop"
 *
 * Options:
 *   --email <addr>    required
 *   --shop  <name>    workspace name            (default "Demo Shop")
 *   --name  <name>    user's display name       (default derived from email)
 *   --role  <role>    manager | super_admin | service_advisor | technician
 *                     (default manager -- full control of its own workspace and
 *                     nothing outside it, which is what a shop owner should be;
 *                     reserve super_admin for AG platform staff, see
 *                     migration 008)
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Client } = require('pg');

const VALID_ROLES = ['super_admin', 'manager', 'service_advisor', 'technician'];

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const email = String(arg('--email', '')).trim().toLowerCase();
  const shop = arg('--shop', 'Demo Shop');
  const role = arg('--role', 'manager');
  const name = arg('--name', email.split('@')[0] || 'Owner');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('[seed] --email <address> is required and must be a valid address.');
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role)) {
    console.error(`[seed] --role must be one of: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }

  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    ssl: process.env.DB_SSL === '0' ? false : { rejectUnauthorized: false },
  });

  await client.connect();

  /* Long enough to satisfy any policy, and safe to paste into a URL or shell. */
  const password = `Ag-${crypto.randomBytes(12).toString('base64url')}!`;
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      'SELECT id, workspace_ids FROM users WHERE lower(email) = lower($1) FOR UPDATE',
      [email]
    );

    let workspaceId;
    let userId;

    if (existing.length) {
      userId = existing[0].id;
      workspaceId = (existing[0].workspace_ids || [])[0];

      if (!workspaceId) {
        workspaceId = `ws-${crypto.randomUUID()}`;
        await client.query(
          `INSERT INTO workspaces (id, name, type, plan, active) VALUES ($1,$2,'mechanic','pro',true)`,
          [workspaceId, shop]
        );
        await client.query('UPDATE users SET workspace_ids = $1 WHERE id = $2', [[workspaceId], userId]);
      }

      await client.query(
        `UPDATE users
            SET password_hash = $1, role = $2, active = true,
                reset_token = NULL, reset_expiry = NULL, updated_at = NOW()
          WHERE id = $3`,
        [passwordHash, role, userId]
      );

      /* The old password is gone; any live session should re-authenticate. */
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      console.log(`[seed] existing user ${email} updated (password reset)`);
    } else {
      workspaceId = `ws-${crypto.randomUUID()}`;
      userId = `usr-${crypto.randomUUID()}`;

      await client.query(
        `INSERT INTO workspaces (id, name, type, plan, active) VALUES ($1,$2,'mechanic','pro',true)`,
        [workspaceId, shop]
      );
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, role, workspace_ids, active)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [userId, name, email, passwordHash, role, [workspaceId]]
      );
      console.log('[seed] workspace and user created');
    }

    await client.query('COMMIT');

    console.log('');
    console.log('  workspace : %s  (%s)', shop, workspaceId);
    console.log('  user      : %s  (%s)', email, userId);
    console.log('  role      : %s', role);
    console.log('  password  : %s', password);
    console.log('');
    console.log('[seed] Sign in, then change this password from the profile page.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[seed]', err.message);
  process.exit(1);
});
