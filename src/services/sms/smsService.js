const logger = require('../../shared/utils/logger');

const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.startsWith('254')) return digits;
  return digits.length === 9 ? `254${digits}` : digits;
};

const sendSms = async ({ to, message, purpose = 'general' }) => {
  const phone = normalizePhone(to);
  if (!phone) {
    logger.warn('SMS skipped: missing phone number', { module: 'sms', purpose });
    return { skipped: true, reason: 'missing_phone' };
  }

  if (process.env.AFRICASTALKING_API_KEY && process.env.AFRICASTALKING_USERNAME) {
    const params = new URLSearchParams({
      username: process.env.AFRICASTALKING_USERNAME,
      to: `+${phone}`,
      message,
      ...(process.env.SMS_SENDER_ID || process.env.AFRICASTALKING_SENDER_ID
        ? { from: process.env.SMS_SENDER_ID || process.env.AFRICASTALKING_SENDER_ID }
        : {}),
    });
    const response = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey: process.env.AFRICASTALKING_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Africa's Talking SMS failed (${response.status}): ${body.slice(0, 200)}`);
    }
    logger.info('SMS sent', { module: 'sms', provider: 'africastalking', purpose, phone, status: response.status });
    return { sent: true, provider: 'africastalking', status: response.status };
  }

  if (process.env.SMS_BASE_URL && process.env.SMS_USERID && process.env.SMS_PASSWORD) {
    const params = new URLSearchParams({
      userid: process.env.SMS_USERID,
      password: process.env.SMS_PASSWORD,
      mobile: phone,
      msg: message,
      sendMethod: process.env.SMS_SEND_METHOD || 'quick',
      senderid: process.env.SMS_SENDERID || process.env.SMS_SENDER_ID || 'AYEDOS',
      msgType: process.env.SMS_MSG_TYPE || 'text',
      duplicatecheck: process.env.SMS_DUPLICATE_CHECK || 'true',
      output: process.env.SMS_OUTPUT || 'json',
    });
    const response = await fetch(`${process.env.SMS_BASE_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json,text/plain,*/*' },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HostPinnacle SMS failed (${response.status}): ${body.slice(0, 200)}`);
    }

    let payload = null;
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {
      payload = { raw: body };
    }

    const normalizedStatus = String(payload?.status || '').toLowerCase();
    const normalizedCode = String(payload?.statusCode || payload?.code || '').toLowerCase();
    const rejected = normalizedStatus
      ? !['success', 'sent', 'queued', 'ok'].includes(normalizedStatus) && normalizedCode !== '200'
      : ['error', 'failed', 'fail', 'insufficient', 'denied', 'blocked'].some((token) => String(payload?.reason || payload?.raw || '').toLowerCase().includes(token));
    if (rejected) {
      throw new Error(`HostPinnacle SMS rejected: ${body.slice(0, 300)}`);
    }

    logger.info('SMS sent', { module: 'sms', provider: 'hostpinnacle', purpose, phone, status: response.status, response: payload });
    return { sent: true, provider: 'hostpinnacle', status: response.status, response: payload };
  }

  const webhookUrl = process.env.SMS_WEBHOOK_URL || process.env.SMS_PROVIDER_URL;
  if (!webhookUrl) {
    logger.warn('SMS skipped: SMS_WEBHOOK_URL is not configured', { module: 'sms', purpose, phone });
    return { skipped: true, reason: 'not_configured' };
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.SMS_API_KEY ? { Authorization: `Bearer ${process.env.SMS_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      to: phone,
      phone,
      message,
      text: message,
      purpose,
      senderId: process.env.SMS_SENDER_ID || 'AYEDOS',
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`SMS provider failed (${response.status}): ${body.slice(0, 200)}`);
  }

  logger.info('SMS sent', { module: 'sms', purpose, phone, status: response.status });
  return { sent: true, status: response.status };
};

const sendOtpSms = ({ to, otp, purpose }) => sendSms({
  to,
  purpose,
  message: `AYEDOS SACCO verification code is ${otp}.\nIt is valid for 10 min.\nDo not share this code.`,
});

module.exports = {
  sendSms,
  sendOtpSms,
};
