const express = require('express');
const { port } = require('./config/env');
const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhooks');
const orderRoutes = require('./routes/orders');

const app = express();

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use(express.json());
app.use('/', authRoutes);
app.use('/orders', orderRoutes);

// Webhooks need the raw body for HMAC validation.
app.use('/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Shopify backend listening on port ${port}`);
});
