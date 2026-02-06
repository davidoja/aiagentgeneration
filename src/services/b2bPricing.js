const { shopifyRequest } = require('./shopifyClient');

const getCustomerPricingProfile = async (customerId, accessToken) => {
  const data = await shopifyRequest(`/customers/${customerId}/metafields.json`, {
    accessToken
  });
  const pricingMetafield = data.metafields.find(
    (field) => field.namespace === 'pricing' && field.key === 'b2b_discount_percent'
  );

  if (!pricingMetafield) {
    return { discountPercent: 0 };
  }

  const discountPercent = Number(pricingMetafield.value || 0);
  return {
    discountPercent: Number.isFinite(discountPercent) ? discountPercent : 0
  };
};

const applyB2BDiscount = (lineItems, discountPercent) => {
  if (!discountPercent || discountPercent <= 0) {
    return lineItems;
  }

  return lineItems.map((item) => {
    const original = Number(item.price || 0);
    const discounted = (original * (100 - discountPercent)) / 100;
    return {
      ...item,
      b2b_price: discounted.toFixed(2)
    };
  });
};

const buildB2BPricedOrder = async (order, accessToken) => {
  const isB2B = order.customer?.tags?.includes('B2B');
  if (!isB2B || !order.customer?.id) {
    return {
      order,
      discountPercent: 0
    };
  }

  const { discountPercent } = await getCustomerPricingProfile(order.customer.id, accessToken);
  return {
    order: {
      ...order,
      line_items: applyB2BDiscount(order.line_items, discountPercent)
    },
    discountPercent
  };
};

module.exports = {
  buildB2BPricedOrder,
  getCustomerPricingProfile,
  applyB2BDiscount
};
