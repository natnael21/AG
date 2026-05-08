const nodemailer = require('nodemailer');
const path = require('path');

// Initialize email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
});

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@agshopro.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@agshopro.com';
const APP_URL = process.env.APP_URL || 'https://agshopro.com';

/**
 * Send rejection email to signup applicant
 */
async function sendRejectionEmail(signup, rejectionComment) {
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

    await transporter.sendMail({
      from: FROM_EMAIL,
      to: signup.contact_email,
      subject: 'AG Shop Pro - Application Review',
      html,
    });

    return { success: true };
  } catch (e) {
    console.error('[Email] Failed to send rejection email:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Send approval email with temp password
 */
async function sendApprovalEmail(user, workspace, tempPassword) {
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

    await transporter.sendMail({
      from: FROM_EMAIL,
      to: user.email,
      subject: 'Welcome to AG Shop Pro - Account Created',
      html,
    });

    return { success: true };
  } catch (e) {
    console.error('[Email] Failed to send approval email:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Send reinstatement notification email
 */
async function sendReinstateEmail(signup) {
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

    await transporter.sendMail({
      from: FROM_EMAIL,
      to: signup.contact_email,
      subject: 'AG Shop Pro - Application Reinstated',
      html,
    });

    return { success: true };
  } catch (e) {
    console.error('[Email] Failed to send reinstate email:', e.message);
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

module.exports = {
  sendRejectionEmail,
  sendApprovalEmail,
  sendReinstateEmail,
};
