const crypto = require('crypto');
const { tx } = require('./db');
const { AppError } = require('./errors');

/**
 * Wraps a state-changing handler with:
 *   - a single DB transaction (change + activity log are atomic)
 *   - optional idempotency via the `Idempotency-Key` header
 *
 * Idempotency design:
 *   The key row is inserted INSIDE the same transaction as the business change.
 *   - First request: inserts the key, runs the handler, stores the response, commits.
 *   - Retry after commit: INSERT ... ON CONFLICT DO NOTHING inserts nothing -> we replay
 *     the stored response and do not touch the business tables again.
 *   - Concurrent duplicate (same key at the same moment): its INSERT blocks on the
 *     unique index until the first transaction finishes, then behaves like a retry
 *     (or, if the first one rolled back, proceeds normally). No double-create.
 *   - Failed requests roll back, key included, so the client may retry after fixing it.
 *   - Same key + different payload/endpoint -> 422 (client bug, never silently replayed).
 *
 * handler(client, req) must return { status, body }.
 */
function mutation(handler) {
  return async (req, res, next) => {
    try {
      const key = req.get('Idempotency-Key');
      if (key !== undefined && (key.length < 8 || key.length > 200)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be 8-200 characters');
      }
      const hash = crypto
        .createHash('sha256')
        .update(`${req.method}\n${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? {})}`)
        .digest('hex');

      const out = await tx(async (client) => {
        if (key) {
          const ins = await client.query(
            `INSERT INTO idempotency_keys (user_id, key, request_hash)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING key`,
            [req.user.id, key, hash]
          );
          if (!ins.rowCount) {
            const ex = (
              await client.query(
                `SELECT request_hash, status_code, response_body
                   FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
                [req.user.id, key]
              )
            ).rows[0];
            if (ex.request_hash !== hash) {
              throw new AppError(
                422,
                'IDEMPOTENCY_KEY_REUSED',
                'This Idempotency-Key was already used with a different request'
              );
            }
            return { status: ex.status_code, body: ex.response_body, replayed: true };
          }
        }
        const result = await handler(client, req);
        if (key) {
          await client.query(
            `UPDATE idempotency_keys SET status_code = $3, response_body = $4
              WHERE user_id = $1 AND key = $2`,
            [req.user.id, key, result.status, JSON.stringify(result.body)]
          );
        }
        return result;
      });

      if (out.replayed) res.set('Idempotent-Replayed', 'true');
      res.status(out.status).json(out.body);
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { mutation };
