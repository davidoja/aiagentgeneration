const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.SHOPIFY_STORE_DOMAIN = 'test-store.myshopify.com';
process.env.SHOPIFY_API_VERSION = '2024-07';
process.env.SHOPIFY_API_KEY = 'test-key';
process.env.SHOPIFY_API_SECRET = 'test-secret';
process.env.SHOPIFY_WEBHOOK_SECRET = 'shpss_test_secret';
process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
delete process.env.NOTIFICATION_WEBHOOK_URL;
delete process.env.EXPORT_WEBHOOK_URL;

const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
const shop = 'test-store.myshopify.com';

const signPayload = (payload) =>
  crypto.createHmac('sha256', webhookSecret).update(payload, 'utf8').digest('base64');

const originalFetch = global.fetch;

global.fetch = async (url, options = {}) => {
  const method = options.method || 'GET';
  const href = String(url);

  if (!href.includes('/admin/api/')) {
    return originalFetch(url, options);
  }

  if (href.includes('/orders/') && method === 'GET') {
    return Response.json({
      order: {
        id: 123,
        name: '#1001',
        tags: '',
        total_price: '19.99',
        line_items: [{ id: 1, price: '19.99' }],
        customer: { id: 9, tags: 'retail' }
      }
    });
  }

  if (href.includes('/orders/') && method === 'PUT') {
    return Response.json({
      order: { id: 123, tags: 'processed, automation:order_created' }
    });
  }

  throw new Error(`Unexpected fetch ${method} ${href}`);
};

const app = require('../src/server');
const { setToken } = require('../src/services/tokenStore');

let server;
let baseUrl;

before(async () => {
  setToken(shop, 'shpat_test_token');
  app.post('/__json-probe', (req, res) => {
    res.status(200).json({
      isBuffer: Buffer.isBuffer(req.body),
      name: req.body && req.body.name
    });
  });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

const postWebhook = (payload, hmac) =>
  fetch(`${baseUrl}/webhooks/orders/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Shop-Domain': shop
    },
    body: payload
  });

test('accepts a correctly HMAC-signed Shopify order webhook', async () => {
  const payload = JSON.stringify({ id: 123, note: 'signed raw body' });
  const response = await postWebhook(payload, signPayload(payload));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { received: true, discountPercent: 0 });
});

test('rejects a webhook when the HMAC does not match the raw body', async () => {
  const payload = JSON.stringify({ id: 123, note: 'tampered' });
  const response = await postWebhook(payload, signPayload('{"id":999}'));
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: 'Invalid webhook HMAC' });
});

test('still parses JSON bodies on non-webhook routes', async () => {
  const response = await fetch(`${baseUrl}/__json-probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ada' })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.isBuffer, false);
  assert.equal(body.name, 'ada');
});
