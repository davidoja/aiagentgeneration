const express = require('express');
const { webhookSecret } = require('../config/env');
const { createHmac, safeCompare } = require('../utils/crypto');
const { getToken } = require('../services/tokenStore');
const { fetchOrder } = require('../services/orders');
const { buildB2BPricedOrder } = require('../services/b2bPricing');
const { runPostOrderAutomation } = require('../workflows/orderAutomation');

const router = express.Router();

const verifyShopifyWebhook = (req, res, next) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader) {
    return res.status(401).json({ error: 'Missing webhook HMAC' });
  }

  const digest = createHmac(webhookSecret, req.body.toString());
  if (!safeCompare(digest, hmacHeader)) {
    return res.status(401).json({ error: 'Invalid webhook HMAC' });
  }

  return next();
};

router.post('/orders/create', verifyShopifyWebhook, async (req, res) => {
  const payload = JSON.parse(req.body.toString());
  const shop = req.get('X-Shopify-Shop-Domain');
  const accessToken = getToken(shop);

  if (!accessToken) {
    return res.status(401).json({ error: 'Missing access token for shop' });
  }

  const order = await fetchOrder(payload.id, accessToken);
  const { order: pricedOrder, discountPercent } = await buildB2BPricedOrder(order, accessToken);

  // Critical: respond quickly to avoid Shopify webhook retries.
  res.status(200).json({ received: true, discountPercent });

  await runPostOrderAutomation({
    order: pricedOrder,
    accessToken,
    reason: 'order_created'
  });
});

router.post('/orders/paid', verifyShopifyWebhook, async (req, res) => {
  const payload = JSON.parse(req.body.toString());
  const shop = req.get('X-Shopify-Shop-Domain');
  const accessToken = getToken(shop);

  if (!accessToken) {
    return res.status(401).json({ error: 'Missing access token for shop' });
  }

  const order = await fetchOrder(payload.id, accessToken);
  res.status(200).json({ received: true });

  await runPostOrderAutomation({
    order,
    accessToken,
    reason: 'payment_captured'
  });
});

router.post('/orders/fulfilled', verifyShopifyWebhook, async (req, res) => {
  const payload = JSON.parse(req.body.toString());
  const shop = req.get('X-Shopify-Shop-Domain');
  const accessToken = getToken(shop);

  if (!accessToken) {
    return res.status(401).json({ error: 'Missing access token for shop' });
  }

  const order = await fetchOrder(payload.order_id, accessToken);
  res.status(200).json({ received: true });

  await runPostOrderAutomation({
    order,
    accessToken,
    reason: 'order_fulfilled'
  });
});

module.exports = router;
