const tokenByShop = new Map();

const setToken = (shop, token) => {
  tokenByShop.set(shop, token);
};

const getToken = (shop) => tokenByShop.get(shop);

module.exports = {
  setToken,
  getToken
};
