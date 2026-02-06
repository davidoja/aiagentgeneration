const crypto = require('crypto');

const safeCompare = (a, b) => {
  const buffA = Buffer.from(a, 'utf8');
  const buffB = Buffer.from(b, 'utf8');
  if (buffA.length !== buffB.length) {
    return false;
  }
  return crypto.timingSafeEqual(buffA, buffB);
};

const createHmac = (secret, data) =>
  crypto.createHmac('sha256', secret).update(data, 'utf8').digest('base64');

module.exports = {
  safeCompare,
  createHmac
};
