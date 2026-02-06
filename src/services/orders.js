const { shopifyRequest } = require('./shopifyClient');

const fetchOrder = async (orderId, accessToken) => {
  const data = await shopifyRequest(`/orders/${orderId}.json`, {
    accessToken
  });
  return data.order;
};

const updateOrderTags = async (orderId, tags, accessToken) => {
  const data = await shopifyRequest(`/orders/${orderId}.json`, {
    method: 'PUT',
    accessToken,
    body: {
      order: {
        id: orderId,
        tags
      }
    }
  });
  return data.order;
};

module.exports = {
  fetchOrder,
  updateOrderTags
};
