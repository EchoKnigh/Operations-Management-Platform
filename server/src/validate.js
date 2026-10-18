const { AppError } = require('./errors');

function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      r.error.issues
    );
  }
  return r.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Malformed ids are treated as "not found" instead of leaking a DB error. */
function uuidParam(req, res, next, value) {
  if (!UUID_RE.test(value)) return next(new AppError(404, 'NOT_FOUND', 'Resource not found'));
  next();
}

module.exports = { parse, uuidParam };
