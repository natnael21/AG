const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/**
 * User Management Service
 * Handles user invitations, role management, and user lifecycle
 */

class UserManagementService {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Invite a user to a workspace
   */
  async inviteUser(workspaceId, inviteData, invitedBy) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const { email, name, role = 'technician', phone } = inviteData;

      if (!email || !name) {
        throw new Error('Email and name are required');
      }

      // Check if user already exists
      const existingUser = await client.query(
        'SELECT id, workspace_ids FROM users WHERE lower(email) = lower($1)',
        [email]
      );

      if (existingUser.rows.length > 0) {
        const user = existingUser.rows[0];
        const workspaceIds = user.workspace_ids || [];

        // Check if already in this workspace
        if (workspaceIds.includes(workspaceId)) {
          throw new Error('User is already a member of this workspace');
        }

        // Add to workspace
        workspaceIds.push(workspaceId);
        await client.query(
          'UPDATE users SET workspace_ids = $1, updated_at = NOW() WHERE id = $2',
          [workspaceIds, user.id]
        );

        await client.query('COMMIT');
        return { user: { ...user, workspace_ids: workspaceIds }, isNew: false };

      } else {
        // Create new user invitation
        const tempPassword = this.generateTempPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 12);

        const insertQuery = `
          INSERT INTO users (
            name, email, phone, password_hash, role, workspace_ids, active
          ) VALUES ($1, $2, $3, $4, $5, $6, true)
          RETURNING *
        `;

        const values = [name, email.toLowerCase(), phone, passwordHash, role, [workspaceId]];

        const result = await client.query(insertQuery, values);
        const newUser = result.rows[0];

        await client.query('COMMIT');
        return { user: newUser, tempPassword, isNew: true };
      }

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update user role in a workspace
   */
  async updateUserRole(userId, workspaceId, newRole, updatedBy) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Validate role
      const validRoles = ['super_admin', 'manager', 'service_advisor', 'technician'];
      if (!validRoles.includes(newRole)) {
        throw new Error('Invalid role');
      }

      // Check if user is in workspace
      const userResult = await client.query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = userResult.rows[0];
      const workspaceIds = user.workspace_ids || [];

      if (!workspaceIds.includes(workspaceId)) {
        throw new Error('User is not a member of this workspace');
      }

      // Update role
      const updateResult = await client.query(
        'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [newRole, userId]
      );

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
   * Remove user from workspace
   */
  async removeUserFromWorkspace(userId, workspaceId, removedBy) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Get user
      const userResult = await client.query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = userResult.rows[0];
      let workspaceIds = user.workspace_ids || [];

      // Remove workspace
      workspaceIds = workspaceIds.filter(id => id !== workspaceId);

      if (workspaceIds.length === 0) {
        // If no workspaces left, deactivate user
        await client.query(
          'UPDATE users SET active = false, workspace_ids = $1, updated_at = NOW() WHERE id = $2',
          [[], userId]
        );
      } else {
        // Update workspace list
        await client.query(
          'UPDATE users SET workspace_ids = $1, updated_at = NOW() WHERE id = $2',
          [workspaceIds, userId]
        );
      }

      await client.query('COMMIT');
      return { success: true, deactivated: workspaceIds.length === 0 };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Deactivate user account
   */
  async deactivateUser(userId, deactivatedBy) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Update user
      const updateResult = await client.query(
        'UPDATE users SET active = false, updated_at = NOW() WHERE id = $1 RETURNING *',
        [userId]
      );

      if (updateResult.rows.length === 0) {
        throw new Error('User not found');
      }

      // Clear all sessions
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

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
   * Reactivate user account
   */
  async reactivateUser(userId, reactivatedBy) {
    const updateResult = await this.pool.query(
      'UPDATE users SET active = true, updated_at = NOW() WHERE id = $1 RETURNING *',
      [userId]
    );

    if (updateResult.rows.length === 0) {
      throw new Error('User not found');
    }

    return updateResult.rows[0];
  }

  /**
   * Update user profile (self-service)
   */
  async updateUserProfile(userId, profileData) {
    const { name, phone, currentPassword, newPassword } = profileData;

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Get current user
      const userResult = await client.query(
        'SELECT * FROM users WHERE id = $1 AND active = true',
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = userResult.rows[0];
      const updates = {};
      const values = [];
      let paramCount = 1;

      // Update basic info
      if (name !== undefined) {
        updates.name = `$${paramCount++}`;
        values.push(name);
      }

      if (phone !== undefined) {
        updates.phone = `$${paramCount++}`;
        values.push(phone);
      }

      // Handle password change
      if (newPassword) {
        if (!currentPassword) {
          throw new Error('Current password is required to change password');
        }

        const isValid = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isValid) {
          throw new Error('Current password is incorrect');
        }

        const newHash = await bcrypt.hash(newPassword, 12);
        updates.password_hash = `$${paramCount++}`;
        values.push(newHash);
      }

      if (Object.keys(updates).length === 0) {
        throw new Error('No fields to update');
      }

      updates.updated_at = 'NOW()';

      const updateQuery = `
        UPDATE users
        SET ${Object.keys(updates).map(key => `${key} = ${updates[key]}`).join(', ')}
        WHERE id = $${paramCount}
        RETURNING id, name, email, phone, role, workspace_ids, active, last_login, updated_at
      `;

      values.push(userId);

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
   * Get workspace users with roles
   */
  async getWorkspaceUsers(workspaceId) {
    const query = `
      SELECT
        u.id, u.name, u.email, u.phone, u.role, u.active,
        u.last_login, u.created_at, u.updated_at,
        array_position(u.workspace_ids, $1) as workspace_index
      FROM users u
      WHERE $1 = ANY(u.workspace_ids)
      ORDER BY u.name
    `;

    const result = await this.pool.query(query, [workspaceId]);
    return result.rows;
  }

  /**
   * Generate temporary password
   */
  generateTempPassword() {
    return `Temp-${uuidv4().slice(0, 8)}!`;
  }

  /**
   * Reset user password (admin function)
   */
  async resetUserPassword(userId, resetBy) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const tempPassword = this.generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      // Update password and clear sessions
      const updateResult = await client.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [passwordHash, userId]
      );

      if (updateResult.rows.length === 0) {
        throw new Error('User not found');
      }

      // Clear all sessions
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

      await client.query('COMMIT');
      return { user: updateResult.rows[0], tempPassword };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = UserManagementService;