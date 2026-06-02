const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const logger = require('../../shared/utils/logger');

const PROVIDER_TIMEOUT_MS = Number(process.env.EMAIL_PROVIDER_TIMEOUT_MS || 4000);
const CIRCUIT_FAILURE_THRESHOLD = Number(process.env.EMAIL_CIRCUIT_FAILURE_THRESHOLD || 3);
const CIRCUIT_RESET_MS = Number(process.env.EMAIL_CIRCUIT_RESET_MS || 60_000);

const withTimeout = (promise, timeoutMs, provider) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${provider} timed out`)), timeoutMs)),
]);

class EmailProvider {
  constructor(name) {
    this.name = name;
    this.failures = 0;
    this.openUntil = 0;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
  }

  isConfigured() {
    return false;
  }

  isAvailable() {
    return this.isConfigured() && this.openUntil <= Date.now();
  }

  async deliver(message) {
    if (!this.isAvailable()) throw new Error(`${this.name} provider unavailable`);
    try {
      const result = await withTimeout(this.send(message), PROVIDER_TIMEOUT_MS, this.name);
      this.failures = 0;
      this.openUntil = 0;
      this.lastSuccessAt = new Date();
      return result;
    } catch (error) {
      this.failures += 1;
      this.lastFailureAt = new Date();
      if (this.failures >= CIRCUIT_FAILURE_THRESHOLD) this.openUntil = Date.now() + CIRCUIT_RESET_MS;
      throw error;
    }
  }

  health() {
    return {
      provider: this.name,
      configured: this.isConfigured(),
      circuit: this.openUntil > Date.now() ? 'open' : 'closed',
      failures: this.failures,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }
}

class ResendProvider extends EmailProvider {
  constructor() {
    super('resend');
    this.client = null;
  }

  isConfigured() {
    return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
  }

  async send(message) {
    this.client ||= new Resend(process.env.RESEND_API_KEY);
    const result = await this.client.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
    if (result.error) throw new Error(result.error.message || 'Resend rejected the email');
    return { messageId: result.data?.id };
  }
}

class SmtpProvider extends EmailProvider {
  constructor() {
    super('smtp');
    this.transporter = null;
  }

  isConfigured() {
    return ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].every((key) => process.env[key]);
  }

  async send(message) {
    this.transporter ||= nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_PORT === '465',
      pool: true,
      maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS || 3),
      connectionTimeout: PROVIDER_TIMEOUT_MS,
      greetingTimeout: PROVIDER_TIMEOUT_MS,
      socketTimeout: PROVIDER_TIMEOUT_MS,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const result = await this.transporter.sendMail({
      from: process.env.SMTP_FROM_EMAIL || `"AYEDOS SACCO" <${process.env.SMTP_USER}>`,
      ...message,
    });
    return { messageId: result.messageId };
  }
}

const providers = [new ResendProvider(), new SmtpProvider()];

const sendEmail = async (message) => {
  const failures = [];
  for (const provider of providers) {
    if (!provider.isAvailable()) continue;
    try {
      const result = await provider.deliver(message);
      logger.info('Email delivered', { module: 'email', provider: provider.name, messageId: result.messageId });
      return { ...result, provider: provider.name };
    } catch (error) {
      failures.push({ provider: provider.name, error: error.message });
      logger.error('Email provider failed', { module: 'email', provider: provider.name, error: error.message });
    }
  }
  throw new Error(failures.length ? 'All configured email providers failed' : 'No healthy email provider configured');
};

const getProviderHealth = () => providers.map((provider) => provider.health());

module.exports = { EmailProvider, sendEmail, getProviderHealth };
