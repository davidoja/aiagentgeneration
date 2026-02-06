const { requestWithRetry } = require('../utils/http');
const { shopDomain, apiVersion } = require('../config/env');

const buildUrl = (path) => `https://${shopDomain}/admin/api/${apiVersion}${path}`;

const shopifyRequest = async (path, { method = 'GET', accessToken, body } = {}) => {
  const url = buildUrl(path);
  const response = await requestWithRetry(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify API error ${response.status}: ${errorText}`);
  }

  return response.json();
};

module.exports = {
  shopifyRequest
};
