const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const { AppError } = require('./errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || true, exposedHeaders: ['Idempotent-Replayed'] }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/teams', require('./routes/teams'));
  app.use('/api/items', require('./routes/items'));
  app.use('/api/dashboard', require('./routes/dashboard'));
  app.use('/api', (req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));

  // Serve the built React app from the same origin in production (single deployable unit).
  const dist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    }
    if (err.code === '23514' || err.code === '23503') {
      // CHECK / FK violation the app logic didn't catch: surface as a conflict, not a 500.
      return res.status(409).json({ error: { code: 'CONSTRAINT_VIOLATION', message: 'Operation violates a data rule' } });
    }
    if (!config.isTest) console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  return app;
}

module.exports = { createApp };
