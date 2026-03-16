// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { createServer } = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const { connectDB, pool, redis } = require(' ./config/database');
const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');
const { authenticateSocket } = require('./middleware/auth');

// Route imports
const authRoutes = require('../routes/auth');
const tradingRoutes = require('../routes/trading');
const userRoutes = require('./routes/user');
const fundingRoutes = require('./routes/funding');
const marketRoutes = require('./routes/market');

// Service imports
const { MarketDataService } = require('../services/marketData');
const { TradingEngine } = require('../services/tradingEngine');
const { RiskManager } = require('../services/riskManager');

const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production'
}));

app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// Request logging
app.use(requestLogger);

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/user', userRoutes);
app.use('/api/funding', fundingRoutes);
app.use('/api/market', marketRoutes);

// WebSocket authentication
io.use(authenticateSocket);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.user.id);
  
  socket.join(`user:${socket.user.id}`);
  
  socket.on('subscribe:market', (symbols) => {
    if (Array.isArray(symbols)) {
      symbols.forEach(symbol => socket.join(`market:${symbol}`));
    }
  });
  
  socket.on('unsubscribe:market', (symbols) => {
    if (Array.isArray(symbols)) {
      symbols.forEach(symbol => socket.leave(`market:${symbol}`));
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.user.id, 'Reason:', reason);
  });
});

// Make io accessible to routes
app.set('io', io);

// Error handling
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Initialize services
const marketData = new MarketDataService(io);
const tradingEngine = new TradingEngine();
const riskManager = new RiskManager();

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`${signal} received. Starting graceful shutdown...`);
  
  // Stop accepting new connections
  httpServer.close(() => {
    console.log('HTTP server closed');
  });
  
  // Stop services
  marketData.stop();
  
  // Close database connections
  await pool.end();
  await redis.quit();
  
  console.log('Graceful shutdown completed');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // Connect to database first
    await connectDB();
    
    // Initialize trading engine
    await tradingEngine.initialize();
    
    // Start market data service
    marketData.start();
    
    // Start risk manager
    riskManager.start();
    
    httpServer.listen(PORT, () => {
      console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// Export for testing
module.exports = { app, httpServer, io, marketData, tradingEngine };