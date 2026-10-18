require('dotenv').config({ quiet: true });

const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = {
  isProd,
  isTest: process.env.NODE_ENV === 'test',
  port: Number(process.env.PORT) || 4000,
  databaseUrl:
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/newtonite',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  bcryptRounds: process.env.NODE_ENV === 'test' ? 4 : 10,
  dbSsl: process.env.DATABASE_SSL === 'true',
};
