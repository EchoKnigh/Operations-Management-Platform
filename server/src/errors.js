class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
const forbidden = (msg = 'You do not have permission to do that') =>
  new AppError(403, 'FORBIDDEN', msg);

module.exports = { AppError, notFound, forbidden };
