const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');
const { AppError } = require('./errors');

const signToken = (user) =>
  jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

const hashPassword = (pw) => bcrypt.hash(pw, config.bcryptRounds);
const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

/**
 * Authenticates the bearer token and loads the user from the DB on every request.
 * Roles are NOT put in the token: they are looked up per team per request, so a
 * demotion or removal takes effect immediately.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.get('Authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new AppError(401, 'UNAUTHENTICATED', 'Missing token');
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
    }
    const r = await db.query('SELECT id, email, name FROM users WHERE id = $1', [payload.sub]);
    if (!r.rows[0]) throw new AppError(401, 'UNAUTHENTICATED', 'User no longer exists');
    req.user = r.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { signToken, hashPassword, verifyPassword, authenticate };
