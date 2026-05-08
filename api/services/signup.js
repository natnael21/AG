const { v4: uuidv4 } = require('uuid');

/**
 * Get column metadata for dynamic table handling
 */
async function getColumnMeta(client, tableName, columnName) {
  const { rows } = await client.query(
    `SELECT data_type, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  return rows[0] || null;
}

/**
 * Generate temporary password
 */
function makeTempPassword() {
  return `Temp-${uuidv4().slice(0, 8)}!`;
}

/**
 * Log signup action to audit trail
 */
async function logSignupAction(client, signupId, action, performedBy, reason, comment, oldStatus, newStatus) {
  await client.query(
    `INSERT INTO signup_audit_log (signup_id, action, performed_by, reason, comment, old_status, new_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [signupId, action, performedBy, reason || null, comment || null, oldStatus || null, newStatus || null]
  );
}

/**
 * Provision a signup: create workspace + user account
 * Returns: { signup, workspace, user, tempPassword }
 */
async function provisionSignup(pool, signupId, reviewerId) {
  const bcrypt = require('bcrypt');
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Fetch signup with lock
    const { rows: srows } = await client.query(
      `SELECT * FROM shop_signups WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [signupId]
    );
    
    if (!srows.length) {
      await client.query('ROLLBACK');
      return { error: 'Signup not found or not in pending status' };
    }
    
    const s = srows[0];

    // Create workspace
    const wsIdMeta = await getColumnMeta(client, 'workspaces', 'id');
    const wsIdIsInt = wsIdMeta && wsIdMeta.data_type.includes('integer');
    const wsNeedsManualId = wsIdMeta && !wsIdMeta.column_default;
    const wsTypeCol = await getColumnMeta(client, 'workspaces', 'shop_type')
      ? 'shop_type'
      : (await getColumnMeta(client, 'workspaces', 'type') ? 'type' : null);

    const wsCols = [];
    const wsVals = [];
    const wsParams = [];
    let p = 1;

    if (wsNeedsManualId) {
      wsCols.push('id');
      if (wsIdIsInt) {
        wsVals.push(`(SELECT COALESCE(MAX(id),0)+1 FROM workspaces)`);
      } else {
        wsVals.push(`$${p++}`);
        wsParams.push(`ws-${uuidv4()}`);
      }
    }
    
    wsCols.push('name'); 
    wsVals.push(`$${p++}`); 
    wsParams.push(s.shop_name);
    
    if (wsTypeCol) { 
      wsCols.push(wsTypeCol); 
      wsVals.push(`$${p++}`); 
      wsParams.push(s.shop_type || 'mechanic'); 
    }
    if (await getColumnMeta(client, 'workspaces', 'plan')) { 
      wsCols.push('plan'); 
      wsVals.push(`$${p++}`); 
      wsParams.push('starter'); 
    }
    if (await getColumnMeta(client, 'workspaces', 'active')) { 
      wsCols.push('active'); 
      wsVals.push('true'); 
    }
    
    const wsSql = `INSERT INTO workspaces (${wsCols.join(', ')}) VALUES (${wsVals.join(', ')}) RETURNING id, name`;
    const { rows: wsRows } = await client.query(wsSql, wsParams);
    
    if (!wsRows.length) {
      throw new Error('Failed to create workspace');
    }
    
    const workspace = wsRows[0];

    // Create user account
    const tempPassword = makeTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    
    const usersIdMeta = await getColumnMeta(client, 'users', 'id');
    const usersNeedsManualId = usersIdMeta && !usersIdMeta.column_default;
    const usersIdIsInt = usersIdMeta && usersIdMeta.data_type.includes('integer');
    const wsIdsMeta = await getColumnMeta(client, 'users', 'workspace_ids');
    const wsIdsIsInt = wsIdsMeta && wsIdsMeta.data_type.includes('integer');

    const uCols = [];
    const uVals = [];
    const uParams = [];
    let u = 1;
    
    if (usersNeedsManualId) {
      uCols.push('id');
      if (usersIdIsInt) {
        uVals.push(`(SELECT COALESCE(MAX(id),0)+1 FROM users)`);
      } else { 
        uVals.push(`$${u++}`); 
        uParams.push(`usr-${uuidv4()}`); 
      }
    }
    
    uCols.push('name');          
    uVals.push(`$${u++}`); 
    uParams.push(s.contact_name || 'Shop Owner');
    
    uCols.push('email');         
    uVals.push(`$${u++}`); 
    uParams.push(String(s.contact_email || '').toLowerCase());
    
    if (await getColumnMeta(client, 'users', 'phone')) { 
      uCols.push('phone'); 
      uVals.push(`$${u++}`); 
      uParams.push(s.contact_phone || null); 
    }
    
    uCols.push('password_hash'); 
    uVals.push(`$${u++}`); 
    uParams.push(passwordHash);
    
    uCols.push('role');          
    uVals.push(`$${u++}`); 
    uParams.push('super_admin');
    
    uCols.push('workspace_ids');
    if (wsIdsIsInt) { 
      uVals.push(`$${u++}`); 
      uParams.push([Number(workspace.id)]); 
    } else { 
      uVals.push(`$${u++}`); 
      uParams.push([String(workspace.id)]); 
    }
    
    if (await getColumnMeta(client, 'users', 'active')) { 
      uCols.push('active'); 
      uVals.push('true'); 
    }

    const userSql = `INSERT INTO users (${uCols.join(', ')}) VALUES (${uVals.join(', ')})
                     RETURNING id, name, email, role, workspace_ids`;
    const { rows: uRows } = await client.query(userSql, uParams);
    
    if (!uRows.length) {
      throw new Error('Failed to create user account');
    }
    
    const user = uRows[0];

    // Update signup to approved
    const { rows: doneRows } = await client.query(
      `UPDATE shop_signups
       SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), workspace_id = $3, user_id = $4
       WHERE id = $1
       RETURNING *`,
      [signupId, reviewerId, workspace.id, user.id]
    );

    if (!doneRows.length) {
      throw new Error('Failed to update signup status');
    }

    // Log action
    await logSignupAction(
      client, 
      signupId, 
      'approved', 
      reviewerId, 
      null, 
      null, 
      'pending', 
      'approved'
    );

    await client.query('COMMIT');
    
    return { 
      success: true,
      signup: doneRows[0], 
      workspace, 
      user, 
      tempPassword 
    };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[provisionSignup]', e.message);
    return { error: e.message };
  } finally {
    client.release();
  }
}

/**
 * Reject a signup with optional comment
 */
async function rejectSignup(pool, signupId, rejectedBy, rejectionComment) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Fetch signup with lock
    const { rows: srows } = await client.query(
      `SELECT * FROM shop_signups WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [signupId]
    );
    
    if (!srows.length) {
      await client.query('ROLLBACK');
      return { error: 'Signup not found or not in pending status' };
    }
    
    const s = srows[0];
    
    // Update signup
    const { rows } = await client.query(
      `UPDATE shop_signups
       SET status = 'rejected', 
           rejected_by = $2, 
           rejected_at = NOW(),
           rejection_comment = $3
       WHERE id = $1
       RETURNING *`,
      [signupId, rejectedBy, rejectionComment || null]
    );

    if (!rows.length) {
      throw new Error('Failed to update signup status');
    }

    // Log action
    await logSignupAction(
      client,
      signupId,
      'rejected',
      rejectedBy,
      'Manual rejection',
      rejectionComment || null,
      'pending',
      'rejected'
    );

    await client.query('COMMIT');
    
    return { success: true, signup: rows[0] };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[rejectSignup]', e.message);
    return { error: e.message };
  } finally {
    client.release();
  }
}

/**
 * Reinstate a rejected signup (set back to pending)
 */
async function reinstateSignup(pool, signupId, reinstatedBy) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Fetch signup with lock
    const { rows: srows } = await client.query(
      `SELECT * FROM shop_signups WHERE id = $1 AND status = 'rejected' FOR UPDATE`,
      [signupId]
    );
    
    if (!srows.length) {
      await client.query('ROLLBACK');
      return { error: 'Signup not found or not in rejected status' };
    }
    
    // Update signup back to pending
    const { rows } = await client.query(
      `UPDATE shop_signups
       SET status = 'pending',
           rejection_comment = NULL,
           rejected_by = NULL,
           rejected_at = NULL,
           reinstated_at = NOW(),
           reinstated_by = $2
       WHERE id = $1
       RETURNING *`,
      [signupId, reinstatedBy]
    );

    if (!rows.length) {
      throw new Error('Failed to reinstate signup');
    }

    // Log action
    await logSignupAction(
      client,
      signupId,
      'reinstated',
      reinstatedBy,
      'Reinstatement after rejection',
      null,
      'rejected',
      'pending'
    );

    await client.query('COMMIT');
    
    return { success: true, signup: rows[0] };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[reinstateSignup]', e.message);
    return { error: e.message };
  } finally {
    client.release();
  }
}

module.exports = {
  provisionSignup,
  rejectSignup,
  reinstateSignup,
  getColumnMeta,
  makeTempPassword,
  logSignupAction,
};
