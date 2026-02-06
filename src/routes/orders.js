const express = require('express');
const { fetchOrder } = require('../services/orders');
const { getToken } = require('../services/tokenStore');
const { buildB2BPricedOrder } = require('../services/b2bPricing');

const router = express.Router();

router.get('/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const shop = req.query.shop;
  if (!shop) {
    return res.status(400).json({ error: 'Missing shop query parameter' });
  }

  const accessToken = getToken(shop);
  if (!accessToken) {
    return res.status(401).json({ error: 'Missing access token for shop' });
  }

  const order = await fetchOrder(orderId, accessToken);
  const { order: pricedOrder, discountPercent } = await buildB2BPricedOrder(order, accessToken);

  return res.json({
    order: pricedOrder,
    discountPercent
  });
});

module.exports = router;
