const nodemailer = require('nodemailer');
const path = require('path');

// Initialize email transporter
let transporter = null;

function initializeTransporter() {
  try {
    const config = {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
    };

    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      config.auth = {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      };
    }

    transporter = nodemailer.createTransport(config);
    console.log('[Email] Transporter initialized with:', {
      host: config.host,
      port: config.port,
      secure: config.secure,
      authConfigured: !!config.auth,
    });
  } catch (e) {
    console.error('[Email] Failed to initialize transporter:', e.message);
  }
}

// Initialize on module load
initializeTransporter();

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@agshopro.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@agshopro.com';
const APP_URL = process.env.APP_URL || 'https://agshopro.com';

/**
 * Send rejection email to signup applicant
 */
async function sendRejectionEmail(signup, rejectionComment) {
  if (!transporter) {
    console.error('[sendRejectionEmail] Transporter not initialized');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>AG Shop Pro Signup Status Update</h2>
        <p>Hi ${escapeHtml(signup.contact_name || 'there')},</p>
        
        <p>We have reviewed your signup application for <strong>${escapeHtml(signup.shop_name)}</strong> and unfortunately, we are unable to proceed at this time.</p>
        
        ${rejectionComment ? `
        <div style="background: #f5f5f5; padding: 15px; margin: 20px 0; border-left: 4px solid #d32f2f;">
          <p><strong>Review Comments:</strong></p>
          <p>${escapeHtml(rejectionComment)}</p>
        </div>
        ` : ''}
        
        <p>If you have questions or would like to reapply, please contact our support team at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
        
        <p>Best regards,<br>The AG Shop Pro Team</p>
      </div>
    `;

    console.log(`[sendRejectionEmail] Sending rejection email to ${signup.contact_email}`);
    
    const result = await transporter.sendMail({
      from: FROM_EMAIL,
      to: signup.contact_email,
      subject: 'AG Shop Pro - Application Review',
      html,
    });

    console.log(`[sendRejectionEmail] Email sent successfully:`, result.messageId);
    return { success: true };
  } catch (e) {
    console.error('[sendRejectionEmail] Failed to send rejection email:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Send approval email with temp password
 */
async function sendApprovalEmail(user, workspace, tempPassword) {
  if (!transporter) {
    console.error('[sendApprovalEmail] Transporter not initialized');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const loginUrl = `${APP_URL}/login`;
    
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>Welcome to AG Shop Pro!</h2>
        <p>Hi ${escapeHtml(user.name || 'there')},</p>
        
        <p>Your signup has been approved! Your workspace <strong>${escapeHtml(workspace.name)}</strong> is now active.</p>
        
        <div style="background: #f5f5f5; padding: 15px; margin: 20px 0; border-left: 4px solid #1976d2;">
          <p><strong>Login Credentials:</strong></p>
          <p>Email: <code>${escapeHtml(user.email)}</code></p>
          <p>Temporary Password: <code>${escapeHtml(tempPassword)}</code></p>
          <p style="margin-top: 15px;"><a href="${loginUrl}" style="display: inline-block; background: #1976d2; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Login Now</a></p>
        </div>
        
        <p><strong>Important:</strong> Please change your password after your first login.</p>
        
        <p>If you need any assistance, contact us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
        
        <p>Best regards,<br>The AG Shop Pro Team</p>
      </div>
    `;

    console.log(`[sendApprovalEmail] Sending approval email to ${user.email}`);
    
    const result = await transporter.sendMail({
      from: FROM_EMAIL,
      to: user.email,
      subject: 'Welcome to AG Shop Pro - Account Created',
      html,
    });

    console.log(`[sendApprovalEmail] Email sent successfully:`, result.messageId);
    return { success: true };
  } catch (e) {
    console.error('[sendApprovalEmail] Failed to send approval email:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Send a password reset link.
 *
 * The link carries a single-use token that /api/auth/reset-password consumes.
 * Called from the forgot-password route, which has already generated and
 * stored the token; this only delivers it. Returns { success } like the other
 * senders so the caller can fall back to logging the link when SMTP is not
 * configured (e.g. local development).
 */
async function sendPasswordResetEmail(user, resetUrl) {
  if (!transporter) {
    console.error('[sendPasswordResetEmail] Transporter not initialized');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>Reset your AG Shop Pro password</h2>
        <p>Hi ${escapeHtml(user.name || 'there')},</p>

        <p>We received a request to reset the password for your AG Shop Pro
        account. Click the button below to choose a new one. This link expires
        in one hour and can be used once.</p>

        <p style="margin: 20px 0;">
          <a href="${resetUrl}" style="display: inline-block; background: #1976d2; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Reset password</a>
        </p>

        <p style="font-size: 13px; color: #666;">If the button does not work, copy and paste this link into your browser:<br>
        <a href="${resetUrl}">${escapeHtml(resetUrl)}</a></p>

        <p>If you did not request this, you can safely ignore this email — your
        password will not change.</p>

        <p>Best regards,<br>The AG Shop Pro Team</p>
      </div>
    `;

    console.log(`[sendPasswordResetEmail] Sending password reset email to ${user.email}`);

    const result = await transporter.sendMail({
      from: FROM_EMAIL,
      to: user.email,
      subject: 'AG Shop Pro - Password Reset',
      html,
    });

    console.log('[sendPasswordResetEmail] Email sent successfully:', result.messageId);
    return { success: true };
  } catch (e) {
    console.error('[sendPasswordResetEmail] Failed to send password reset email:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Send reinstatement notification email
 */
async function sendReinstateEmail(signup) {
  if (!transporter) {
    console.error('[sendReinstateEmail] Transporter not initialized');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>AG Shop Pro Signup Reinstated</h2>
        <p>Hi ${escapeHtml(signup.contact_name || 'there')},</p>
        
        <p>Your signup application for <strong>${escapeHtml(signup.shop_name)}</strong> has been reinstated and is pending review.</p>
        
        <p>We will contact you shortly with an update.</p>
        
        <p>Best regards,<br>The AG Shop Pro Team</p>
      </div>
    `;

    console.log(`[sendReinstateEmail] Sending reinstate email to ${signup.contact_email}`);
    
    const result = await transporter.sendMail({
      from: FROM_EMAIL,
      to: signup.contact_email,
      subject: 'AG Shop Pro - Application Reinstated',
      html,
    });

    console.log(`[sendReinstateEmail] Email sent successfully:`, result.messageId);
    return { success: true };
  } catch (e) {
    console.error('[sendReinstateEmail] Failed to send reinstate email:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

async function verifyTransporter() {
  if (!transporter) return { ok: false, error: 'transporter not initialized' };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  sendRejectionEmail,
  sendApprovalEmail,
  sendReinstateEmail,
  sendPasswordResetEmail,
  verifyTransporter,
};
