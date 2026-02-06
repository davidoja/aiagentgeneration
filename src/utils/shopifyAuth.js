const crypto = require('crypto');

const buildAuthUrl = ({ shop, apiKey, scopes, redirectUri, state }) => {
  const params = new URLSearchParams({
    client_id: apiKey,
    scope: scopes,
    redirect_uri: redirectUri,
    state
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
};

const validateOAuthHmac = (query, apiSecret) => {
  const { hmac, signature, ...rest } = query;
  if (!hmac) {
    return false;
  }
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(',') : rest[key]}`)
    .join('&');

  const generated = crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(generated, 'utf8'), Buffer.from(hmac, 'utf8'));
};

const buildState = () => crypto.randomBytes(16).toString('hex');

module.exports = {
  buildAuthUrl,
  validateOAuthHmac,
  buildState
};
