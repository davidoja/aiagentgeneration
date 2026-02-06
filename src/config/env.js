const dotenv = require('dotenv');

dotenv.config();

const required = [
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_API_VERSION',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_WEBHOOK_SECRET',
  'APP_BASE_URL'
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.warn(`Missing required env vars: ${missing.join(', ')}`);
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  shopDomain: process.env.SHOPIFY_STORE_DOMAIN,
  apiVersion: process.env.SHOPIFY_API_VERSION,
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecret: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES || 'read_orders',
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
  notificationWebhookUrl: process.env.NOTIFICATION_WEBHOOK_URL || null,
  exportWebhookUrl: process.env.EXPORT_WEBHOOK_URL || null,
  appBaseUrl: process.env.APP_BASE_URL
};
