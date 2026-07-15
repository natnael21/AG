const bcrypt = require('bcrypt');
const crypto = require('crypto');
const {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  requireString,
  optionalString,
} = require('./errors');

/**
 * User Management Service
 * Handles user invitations, role management, and user lifecycle.
 *
 * Authority rules, enforced here rather than in the routes so they hold for
 * every caller:
 *   - Only a super_admin may grant or remove the super_admin role.
 *   - A manager may only act on users who are members of the workspace they
 *     are managing, and never on a super_admin.
 *   - Nobody may change their own role or deactivate themselves, which would
 *     otherwise let a shop lock itself out or silently self-promote.
 */

const VALID_ROLES = ['super_admin', 'manager', 'service_advisor', 'technician'];

class UserManagementService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Check that `actor` is allowed to act on `target` inside `workspaceId`.
   * `actor` is the request session: { user_id, role }.
   */
  assertCanManage(actor, target, workspaceId, { newRole } = {}) {
    const actorRole = actor?.role;
    const actorId = Number(actor?.user_id);

    if (actorRole !== 'super_admin' && actorRole !== 'manager') {
      throw new ForbiddenError('You do not have permission to manage users.');
    }

    if (target && Number(target.id) === actorId) {
      throw new ForbiddenError('You cannot change your own role or status.');
    }

    if (actorRole === 'super_admin') return;

    /* Manager path. */
    if (newRole === 'super_admin') {
      throw new ForbiddenError('Only a super admin can grant the super admin role.');
    }
    if (target) {
      if (target.role === 'super_admin') {
        throw new ForbiddenError('You do not have permission to manage a super admin.');
      }
      const memberships = (target.workspace_ids || []).map(Number);
      if (!memberships.includes(Number(workspaceId))) {
        throw new NotFoundError('User not found in this workspace.');
      }
    }
  }

  /**
   * Invite a user to a workspace, or add an existing user to it.
   */
  async inviteUser(workspaceId, inviteData, actor) {
    const data = inviteData || {};
    const email = requireString(data.email, 'email', { max: 200 }).toLowerCase();
    const name = requireString(data.name, 'name', { max: 200 });
    const phone = optionalString(data.phone, { max: 40 });
    const role = data.role || 'technician';

    if (!VALID_ROLES.includes(role)) {
      throw new ValidationError(`role must be one of: ${VALID_ROLES.join(', ')}.`);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ValidationError('email is not a valid address.');
    }
    this.assertCanManage(actor, null, workspaceId, { newRole: role });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: existing } = await client.query(
        'SELECT id, name, email, role, workspace_ids, active FROM users WHERE lower(email) = lower($1) FOR UPDATE',
        [email]
      );

      if (existing.length) {
        const user = existing[0];
        const workspaceIds = (user.workspace_ids || []).map(Number);

        if (workspaceIds.includes(Number(workspaceId))) {
          throw new ConflictError('That user is already a member of this workspace.');
        }
        /* Adding an existing super_admin to a workspace is a super_admin act. */
        if (user.role === 'super_admin' && actor?.role !== 'super_admin') {
          throw new ForbiddenError('You do not have permission to manage a super admin.');
        }

        workspaceIds.push(Number(workspaceId));
        const { rows } = await client.query(
          `UPDATE users SET workspace_ids = $1, active = true, updated_at = NOW()
            WHERE id = $2
            RETURNING id, name, email, phone, role, workspace_ids, active`,
          [workspaceIds, user.id]
        );

        await client.query('COMMIT');
        return { user: rows[0], isNew: false };
      }

      const tempPassword = this.generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const { rows } = await client.query(
        `INSERT INTO users (name, email, phone, password_hash, role, workspace_ids, active)
         VALUES ($1,$2,$3,$4,$5,$6,true)
         RETURNING id, name, email, phone, role, workspace_ids, active, created_at`,
        [name, email, phone, passwordHash, role, [Number(workspaceId)]]
      );

      await client.query('COMMIT');
      return { user: rows[0], tempPassword, isNew: true };
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') throw new ConflictError('A user with that email already exists.');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Change a user's role within a workspace.
   */
  async updateUserRole(userId, workspaceId, newRole, actor) {
    if (!VALID_ROLES.includes(newRole)) {
      throw new ValidationError(`role must be one of: ${VALID_ROLES.join(', ')}.`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: found } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!found.length) throw new NotFoundError('User not found.');

      const target = found[0];
      this.assertCanManage(actor, target, workspaceId, { newRole });

      const memberships = (target.workspace_ids || []).map(Number);
      if (!memberships.includes(Number(workspaceId))) {
        throw new NotFoundError('User not found in this workspace.');
      }

      const { rows } = await client.query(
        `UPDATE users SET role = $1, updated_at = NOW()
          WHERE id = $2
          RETURNING id, name, email, phone, role, workspace_ids, active`,
        [newRole, userId]
      );

      /* A role change alters authority; make them re-authenticate. */
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

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
   * Remove a user from a workspace; deactivate them if it was their last.
   */
  async removeUserFromWorkspace(userId, workspaceId, actor) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: found } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!found.length) throw new NotFoundError('User not found.');

      const target = found[0];
      this.assertCanManage(actor, target, workspaceId);

      const remaining = (target.workspace_ids || []).map(Number).filter((id) => id !== Number(workspaceId));
      const deactivated = remaining.length === 0;

      await client.query(
        'UPDATE users SET workspace_ids = $1, active = $2, updated_at = NOW() WHERE id = $3',
        [remaining, !deactivated, userId]
      );

      /* Their session carries the old workspace list, so end it. */
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

      await client.query('COMMIT');
      return { success: true, deactivated };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async deactivateUser(userId, actor) {
    if (Number(userId) === Number(actor?.user_id)) {
      throw new ForbiddenError('You cannot deactivate your own account.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE users SET active = false, updated_at = NOW()
          WHERE id = $1
          RETURNING id, name, email, role, workspace_ids, active`,
        [userId]
      );
      if (!rows.length) throw new NotFoundError('User not found.');

      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async reactivateUser(userId, actor) {
    const { rows } = await this.pool.query(
      `UPDATE users SET active = true, updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, email, role, workspace_ids, active`,
      [userId]
    );
    if (!rows.length) throw new NotFoundError('User not found.');
    return rows[0];
  }

  /**
   * Self-service profile update.
   */
  async updateUserProfile(userId, profileData) {
    const data = profileData || {};
    const { name, phone, currentPassword, newPassword } = data;

    const sets = [];
    const values = [];

    if (name !== undefined) {
      values.push(requireString(name, 'name', { max: 200 }));
      sets.push(`name = $${values.length}`);
    }
    if (phone !== undefined) {
      values.push(optionalString(phone, { max: 40 }));
      sets.push(`phone = $${values.length}`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: found } = await client.query(
        'SELECT * FROM users WHERE id = $1 AND active = true FOR UPDATE',
        [userId]
      );
      if (!found.length) throw new NotFoundError('User not found.');

      if (newPassword) {
        if (!currentPassword) throw new ValidationError('Current password is required to set a new one.');
        if (String(newPassword).length < 8) throw new ValidationError('New password must be at least 8 characters.');

        const isValid = await bcrypt.compare(String(currentPassword), found[0].password_hash);
        if (!isValid) throw new ValidationError('Current password is incorrect.');

        values.push(await bcrypt.hash(String(newPassword), 12));
        sets.push(`password_hash = $${values.length}`);
      }

      if (!sets.length) throw new ValidationError('No updatable fields supplied.');

      values.push(userId);
      const { rows } = await client.query(
        `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${values.length}
          RETURNING id, name, email, phone, role, workspace_ids, active, last_login, updated_at`,
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
   * Members of a workspace.
   */
  async getWorkspaceUsers(workspaceId) {
    const { rows } = await this.pool.query(
      `SELECT id, name, email, phone, role, active, last_login, created_at, updated_at
         FROM users
        WHERE $1 = ANY(workspace_ids)
        ORDER BY name`,
      [workspaceId]
    );
    return rows;
  }

  generateTempPassword() {
    return `Temp-${crypto.randomBytes(9).toString('base64url')}!`;
  }

  /**
   * Admin password reset. Returns a temporary password to hand to the user.
   */
  async resetUserPassword(userId, workspaceId, actor) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: found } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!found.length) throw new NotFoundError('User not found.');

      this.assertCanManage(actor, found[0], workspaceId);

      const tempPassword = this.generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const { rows } = await client.query(
        `UPDATE users SET password_hash = $1, reset_token = NULL, reset_expiry = NULL, updated_at = NOW()
          WHERE id = $2
          RETURNING id, name, email, role, workspace_ids, active`,
        [passwordHash, userId]
      );

      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
      return { user: rows[0], tempPassword };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

module.exports = UserManagementService;
