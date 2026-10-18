const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { AppError } = require('../errors');
const { parse } = require('../validate');
const { signToken, hashPassword, verifyPassword, authenticate } = require('../auth');

const router = express.Router();

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

async function memberships(userId) {
  const r = await db.query(
    `SELECT t.id AS "teamId", t.name AS "teamName", m.role
       FROM memberships m JOIN teams t ON t.id = m.team_id
      WHERE m.user_id = $1 ORDER BY t.name`,
    [userId]
  );
  return r.rows;
}

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = parse(registerSchema, req.body);
    const hash = await hashPassword(password);
    let user;
    try {
      const r = await db.query(
        'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
        [name, email, hash]
      );
      user = r.rows[0];
    } catch (e) {
      if (e.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'That email is already registered');
      throw e;
    }
    res.status(201).json({ token: signToken(user), user, memberships: [] });
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = parse(loginSchema, req.body);
    const r = await db.query(
      'SELECT id, name, email, password_hash FROM users WHERE lower(email) = $1',
      [email]
    );
    const row = r.rows[0];
    // Same error for unknown email and wrong password (no account enumeration).
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
    }
    const user = { id: row.id, name: row.name, email: row.email };
    res.json({ token: signToken(user), user, memberships: await memberships(user.id) });
  } catch (e) {
    next(e);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    res.json({ user: req.user, memberships: await memberships(req.user.id) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
