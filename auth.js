// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { body, validationResult } = require('express-validator');
const { pool, redis } = require(' ../config/database');
const { authenticateToken } = require('../middleware/auth');
const emailService = require('../services/email');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error('JWT secrets must be defined in environment variables');
}

// Register
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/),
  body('firstName').trim().isLength({ min: 2 }),
  body('lastName').trim().isLength({ min: 2 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, firstName, lastName } = req.body;
    
    // Check if user exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create user with transaction
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name) 
       VALUES ($1, $2, $3, $4) RETURNING id, email, created_at`,
      [email, passwordHash, firstName, lastName]
    );

    const user = result.rows[0];

    // Create default balances
    await pool.query(
      `INSERT INTO balances (user_id, currency) VALUES ($1, 'USD'), ($1, 'BTC'), ($1, 'ETH')`,
      [user.id]
    );

    // Send welcome email (fire and forget with proper error handling)
    emailService.sendWelcomeEmail(email, firstName).catch(err => {
      console.error('Failed to send welcome email:', err);
    });

    // Generate tokens
    const tokens = generateTokens(user.id);

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        firstName,
        lastName
      },
      ...tokens
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password, twoFactorCode, captchaToken } = req.body;

    // Verify captcha if enabled
    if (process.env.ENABLE_CAPTCHA === 'true') {
      const captchaValid = await verifyCaptcha(captchaToken);
      if (!captchaValid) {
        return res.status(400).json({ error: 'Invalid captcha' });
      }
    }

    // Check rate limiting
    const attemptsKey = `login_attempts:${email}`;
    const attempts = parseInt(await redis.get(attemptsKey) || '0');
    
    if (attempts >= 5) {
      return res.status(429).json({
        error: 'Too many failed attempts. Please try again later.',
        retryAfter: 3600,
      });
    }

    // Find user
    const result = await pool.query(
      'SELECT id, email, password_hash, two_factor_enabled, two_factor_secret, first_name, last_name, kyc_status FROM users WHERE email = $1 AND is_active = true',
      [email]
    );

    if (result.rows.length === 0) {
      await redis.incr(attemptsKey);
      await redis.expire(attemptsKey, 3600);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      await redis.incr(attemptsKey);
      await redis.expire(attemptsKey, 3600);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check 2FA if enabled
    if (user.two_factor_enabled) {
      if (!twoFactorCode) {
        return res.status(403).json({ 
          error: '2FA required',
          requiresTwoFactor: true 
        });
      }

      const verified = speakeasy.totp.verify({
        secret: user.two_factor_secret,
        encoding: 'base32',
        token: twoFactorCode,
        window: 2
      });

      if (!verified) {
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }

    // Clear login attempts
    await redis.del(attemptsKey);

    // Update last login
    await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    // Generate tokens
    const tokens = generateTokens(user.id);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        kycStatus: user.kyc_status,
        twoFactorEnabled: user.two_factor_enabled
      },
      ...tokens
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Setup 2FA
router.post('/2fa/setup', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const secret = speakeasy.generateSecret({
      name: `NexusTrade:${user.rows[0].email}`,
      length: 32
    });

    // Store temporarily
    await redis.setex(`2fa_setup:${req.user.id}`, 600, secret.base32);

    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    res.json({
      secret: secret.base32,
      qrCode: qrCodeUrl,
      manualEntryKey: secret.base32
    });

  } catch (error) {
    console.error('2FA setup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify and enable 2FA
router.post('/2fa/verify', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    
    const secret = await redis.get(`2fa_setup:${req.user.id}`);
    if (!secret) {
      return res.status(400).json({ error: 'Setup expired. Please start again.' });
    }

    const verified = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 2
    });

    if (!verified) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Enable 2FA
    await pool.query(
      'UPDATE users SET two_factor_enabled = true, two_factor_secret = $1 WHERE id = $2',
      [secret, req.user.id]
    );

    await redis.del(`2fa_setup:${req.user.id}`);

    res.json({ message: '2FA enabled successfully' });

  } catch (error) {
    console.error('2FA verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Refresh token
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    // Check blacklist
    const blacklisted = await redis.get(`blacklist:${refreshToken}`);
    if (blacklisted) {
      return res.status(401).json({ error: 'Token revoked' });
    }

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    
    if (typeof decoded === 'string' || !decoded.userId) {
      return res.status(401).json({ error: 'Invalid token format' });
    }

    const tokens = generateTokens(decoded.userId);

    // Blacklist old token
    await redis.setex(`blacklist:${refreshToken}`, 7 * 24 * 3600, '1');

    res.json(tokens);

  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      await redis.setex(`blacklist:${token}`, 3600, '1');
    }

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper functions
function generateTokens(userId) {
  const accessToken = jwt.sign(
    { userId, type: 'access' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );

  return { accessToken, refreshToken };
}

async function verifyCaptcha(token) {
  try {
    // For Node.js 18+, native fetch is available. For older versions, use node-fetch
    const fetch = globalThis.fetch || require('node-fetch');
    
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${process.env.RECAPTCHA_SECRET}&response=${token}`,
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data.success === true && (data.score === undefined || data.score > 0.5);
  } catch (error) {
    console.error('Captcha verification error:', error);
    return false;
  }
}

module.exports = router;