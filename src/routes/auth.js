const express = require('express');
const { apiKey, apiSecret, scopes, appBaseUrl } = require('../config/env');
const { buildAuthUrl, validateOAuthHmac, buildState } = require('../utils/shopifyAuth');
const { setToken } = require('../services/tokenStore');

const router = express.Router();
const stateStore = new Map();

router.get('/auth', (req, res) => {
  const { shop } = req.query;
  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter' });
  }

  const state = buildState();
  stateStore.set(state, shop);

  const redirectUri = `${appBaseUrl}/auth/callback`;
  const authUrl = buildAuthUrl({
    shop,
    apiKey,
    scopes,
    redirectUri,
    state
  });

  return res.redirect(authUrl);
});

router.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;
  if (!shop || !code || !state) {
    return res.status(400).json({ error: 'Missing callback parameters' });
  }

  if (stateStore.get(state) !== shop) {
    return res.status(400).json({ error: 'Invalid OAuth state' });
  }
  stateStore.delete(state);

  if (!validateOAuthHmac(req.query, apiSecret)) {
    return res.status(401).json({ error: 'Invalid OAuth HMAC' });
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      code
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    return res.status(response.status).json({ error: errorText });
  }

  const data = await response.json();

  setToken(shop, data.access_token);

  return res.json({
    message: 'Shop installed successfully',
    shop,
    scopes: data.scope
  });
});

module.exports = router;
