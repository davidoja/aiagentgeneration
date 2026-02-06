const { updateOrderTags } = require('../services/orders');
const { notificationWebhookUrl, exportWebhookUrl } = require('../config/env');

const postWebhook = async (url, payload) => {
  if (!url) {
    return;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Automation webhook failed: ${errorText}`);
  }
};

const runPostOrderAutomation = async ({ order, accessToken, reason }) => {
  const existingTags = order.tags ? order.tags.split(',').map((tag) => tag.trim()) : [];
  const newTags = Array.from(new Set([...existingTags, 'processed', `automation:${reason}`]));

  // Critical: tags update must be idempotent to avoid duplicate tags in automation retries.
  await updateOrderTags(order.id, newTags.join(', '), accessToken);

  await postWebhook(notificationWebhookUrl, {
    event: 'order_automation',
    reason,
    orderId: order.id,
    orderName: order.name,
    totalPrice: order.total_price
  });

  await postWebhook(exportWebhookUrl, {
    event: 'order_export',
    order
  });
};

module.exports = {
  runPostOrderAutomation
};
