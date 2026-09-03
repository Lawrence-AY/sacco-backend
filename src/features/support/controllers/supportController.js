const asyncHandler = require('../../../shared/utils/asyncHandler');
const { success } = require('../../../shared/utils/response');
const { QUEUES, enqueueEmail } = require('../../../services/email/emailQueue');

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || process.env.CONTACT_EMAIL || 'sacco@ayedosgroup.com';

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const buildSupportEmail = ({ inquiry, requester }) => {
  const roleLabel = inquiry.roleLabel || requester?.role || 'Member';
  const memberName = inquiry.name || requester?.name || [requester?.firstName, requester?.lastName].filter(Boolean).join(' ') || 'Member';
  const memberEmail = inquiry.email || requester?.email || '';
  const memberPhone = inquiry.phone || requester?.phone || requester?.phoneNumber || '';
  const subject = `AYEDOS SACCO ${roleLabel} ${inquiry.type}: ${inquiry.subject}`;
  const rows = [
    ['Name', memberName],
    ['Email', memberEmail],
    ['Phone', memberPhone],
    ['Account role', roleLabel],
    ['Inquiry type', inquiry.type],
    ['Submitted by user ID', requester?.id || requester?.uid || 'Not available'],
  ];

  const text = [
    ...rows.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`),
    '',
    'Message:',
    inquiry.message,
  ].join('\n');

  const htmlRows = rows
    .filter(([, value]) => value)
    .map(([label, value]) => `
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;color:#334155;">${escapeHtml(label)}</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;color:#0f172a;">${escapeHtml(value)}</td>
      </tr>
    `)
    .join('');

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5;">
      <h2 style="margin:0 0 16px;">New AYEDOS SACCO support inquiry</h2>
      <table style="border-collapse:collapse;margin-bottom:18px;">${htmlRows}</table>
      <h3 style="margin:0 0 8px;">Message</h3>
      <p style="white-space:pre-wrap;margin:0;">${escapeHtml(inquiry.message)}</p>
    </div>
  `;

  return { to: SUPPORT_EMAIL, subject, text, html };
};

const submitInquiry = asyncHandler(async (req, res) => {
  const emailJobId = await enqueueEmail(
    QUEUES.NOTIFICATIONS,
    'NOTIFICATION',
    buildSupportEmail({ inquiry: req.body, requester: req.user }),
    { immediate: true },
  );

  return success(res, { emailJobId }, 'Your inquiry has been sent to support.', 202);
});

module.exports = {
  submitInquiry,
};
