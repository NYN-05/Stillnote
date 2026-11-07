class StoreError extends Error {
  constructor(message, statusCode = 500, code = 'STORE_ERROR', details) {
    super(message);
    this.name = 'StoreError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

module.exports = { StoreError };
