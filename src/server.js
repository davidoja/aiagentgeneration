const express = require('express');
const { port } = require('./config/env');
const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhooks');
const orderRoutes = require('./routes/orders');

const app = express();

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Webhooks must see the raw body for HMAC validation. Register this before
// the global JSON parser so express.json() does not consume the stream first.
app.use('/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

app.use(express.json());
app.use('/', authRoutes);
app.use('/orders', orderRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Shopify backend listening on port ${port}`);
  });
}

module.exports = app;
