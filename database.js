// config/database.js
const { Pool } = require('pg');
const Redis = require('ioredis');

// PostgreSQL configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'nexustrade',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Error handling for pool
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
  // Don't crash - let the app handle reconnection
});

pool.on('connect', () => {
  console.log('New PostgreSQL connection established');
});

// Redis configuration
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  showFriendlyErrorStack: process.env.NODE_ENV !== 'production'
});

// Redis event handlers
redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

redis.on('reconnecting', () => {
  console.log('Redis reconnecting...');
});

const connectDB = async () => {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT NOW()');
      console.log('PostgreSQL connection verified');
    } finally {
      client.release();
    }
    
    await initializeTables();
    return true;
  } catch (err) {
    console.error('Database connection error:', err);
    throw err;
  }
};

const initializeTables = async () => {
  const client = await pool.connect();
  try {
    // Check if tables exist by checking users table
    const checkTable = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `);
    
    if (checkTable.rows[0].exists) {
      console.log('Database tables already exist');
      return;
    }

    console.log('Creating database tables...');
    
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        kyc_status VARCHAR(20) DEFAULT 'pending',
        kyc_verified_at TIMESTAMP,
        two_factor_secret VARCHAR(255),
        two_factor_enabled BOOLEAN DEFAULT false,
        account_tier VARCHAR(20) DEFAULT 'basic',
        daily_limit DECIMAL(15,2) DEFAULT 10000.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS balances (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        currency VARCHAR(10) NOT NULL,
        available DECIMAL(20,8) DEFAULT 0,
        held DECIMAL(20,8) DEFAULT 0,
        total DECIMAL(20,8) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, currency)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        client_order_id VARCHAR(100),
        symbol VARCHAR(20) NOT NULL,
        side VARCHAR(10) NOT NULL,
        type VARCHAR(20) NOT NULL,
        quantity DECIMAL(20,8) NOT NULL,
        filled_quantity DECIMAL(20,8) DEFAULT 0,
        price DECIMAL(20,8),
        stop_price DECIMAL(20,8),
        time_in_force VARCHAR(10) DEFAULT 'GTC',
        status VARCHAR(20) DEFAULT 'pending',
        filled_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trades (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID REFERENCES orders(id),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        symbol VARCHAR(20) NOT NULL,
        side VARCHAR(10) NOT NULL,
        quantity DECIMAL(20,8) NOT NULL,
        price DECIMAL(20,8) NOT NULL,
        fee DECIMAL(20,8) DEFAULT 0,
        fee_currency VARCHAR(10),
        realized_pnl DECIMAL(20,8),
        is_maker BOOLEAN DEFAULT false,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS positions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        symbol VARCHAR(20) NOT NULL,
        side VARCHAR(10) NOT NULL,
        quantity DECIMAL(20,8) NOT NULL,
        entry_price DECIMAL(20,8) NOT NULL,
        mark_price DECIMAL(20,8),
        liquidation_price DECIMAL(20,8),
        margin_used DECIMAL(20,8),
        leverage DECIMAL(5,2) DEFAULT 1.0,
        unrealized_pnl DECIMAL(20,8) DEFAULT 0,
        realized_pnl DECIMAL(20,8) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'open',
        opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        amount DECIMAL(20,8) NOT NULL,
        fee DECIMAL(20,8) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        external_id VARCHAR(255),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS market_data (
        symbol VARCHAR(20) PRIMARY KEY,
        price DECIMAL(20,8) NOT NULL,
        bid DECIMAL(20,8),
        ask DECIMAL(20,8),
        volume_24h DECIMAL(20,8),
        change_24h DECIMAL(10,4),
        high_24h DECIMAL(20,8),
        low_24h DECIMAL(20,8),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
      CREATE INDEX IF NOT EXISTS idx_positions_user_id ON positions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
    `);
    
    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Failed to initialize tables:', error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  redis,
  connectDB,
  query: (text, params) => pool.query(text, params)
};