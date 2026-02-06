const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestWithRetry = async (url, options = {}, retries = 2) => {
  const response = await fetch(url, options);
  if (response.status === 429 && retries > 0) {
    const retryAfter = Number(response.headers.get('Retry-After') || 1);
    await sleep(retryAfter * 1000);
    return requestWithRetry(url, options, retries - 1);
  }
  return response;
};

module.exports = {
  requestWithRetry
};
