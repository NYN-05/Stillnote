const crypto = require('node:crypto');
const argon2 = require('argon2');
const { StoreError } = require('./documentStore');

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;
const MAX_CACHE_ENTRIES = 10_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

class AuthService {
  constructor(pool, { sessionTtlMs, allowRegistration = true, cacheTtlMs = 15_000 } = {}) {
    this.pool = pool;
    this.sessionTtlMs = sessionTtlMs;
    this.allowRegistration = allowRegistration;
    this.cacheTtlMs = cacheTtlMs;
    // Verified sessions are cached briefly so a typing user does not cost a lookup per save.
    // A logout on another process takes effect within cacheTtlMs.
    this.cache = new Map();
    this.decoyHash = null;
  }

  async register(rawEmail, password) {
    if (!this.allowRegistration) {
      throw new StoreError('Registration is closed.', 403, 'REGISTRATION_CLOSED');
    }
    const email = normalizeEmail(rawEmail);
    validatePassword(password);
    const passwordHash = await argon2.hash(password);
    let user;
    try {
      const { rows } = await this.pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email', [
        email,
        passwordHash,
      ]);
      user = rows[0];
    } catch (error) {
      if (error.code === '23505') throw new StoreError('An account with this email already exists.', 409, 'EMAIL_TAKEN');
      throw error;
    }
    return { user, token: await this.createSession(user.id) };
  }

  async login(rawEmail, password) {
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    const { rows } = await this.pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    const record = rows[0];
    // Unknown emails still pay for a hash check so response time does not reveal which exist.
    const ok = await this.verify(record?.password_hash ?? (await this.getDecoyHash()), password);
    if (!record || !ok) throw new StoreError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
    // Opportunistic cleanup keeps the table from growing without a scheduler.
    this.pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => undefined);
    return { user: { id: record.id, email: record.email }, token: await this.createSession(record.id) };
  }

  async resolve(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const tokenHash = hashToken(token);
    const cached = this.cache.get(tokenHash);
    if (cached && cached.until > Date.now()) return cached.user;
    this.cache.delete(tokenHash);

    const { rows } = await this.pool.query(
      `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    const user = rows[0] ?? null;
    if (user) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
      this.cache.set(tokenHash, { user, until: Date.now() + this.cacheTtlMs });
    }
    return user;
  }

  async logout(token) {
    if (typeof token !== 'string' || !token) return;
    const tokenHash = hashToken(token);
    this.cache.delete(tokenHash);
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
      hashToken(token),
      userId,
      new Date(Date.now() + this.sessionTtlMs),
    ]);
    return token;
  }

  async verify(hash, password) {
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false; // malformed hash, e.g. the placeholder account
    }
  }

  async getDecoyHash() {
    this.decoyHash ??= argon2.hash(crypto.randomBytes(16).toString('hex'));
    return this.decoyHash;
  }
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new StoreError('Enter a valid email address.', 400, 'INVALID_EMAIL');
  }
  return email;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new StoreError(`Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`, 400, 'INVALID_PASSWORD');
  }
}

module.exports = { AuthService, MIN_PASSWORD_LENGTH };
