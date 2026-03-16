// routes/trading.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireKYC } = require('../middleware/auth');
const tradingEngine = require(' ../services/tradingEngine');
const { pool } = require(' ../config/database');
const router = express.Router();

// Get order book
router.get('/orderbook/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { depth = 20 } = req.query;
    
    const orderBook = tradingEngine.getOrderBook(symbol, parseInt(depth));
    
    res.json({
      symbol,
      timestamp: Date.now(),
      ...orderBook
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent trades
router.get('/trades/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { limit = 50 } = req.query;

    const trades = await pool.query(
      `SELECT t.*, u.first_name as maker_name 
       FROM trades t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE t.symbol = $1 
       ORDER BY t.executed_at DESC 
       LIMIT $2`,
      [symbol, limit]
    );

    res.json(trades.rows);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Place order
router.post('/orders', authenticateToken, requireKYC, [
  body('symbol').isLength({ min: 3 }),
  body('side').isIn(['buy', 'sell']),
  body('type').isIn(['market', 'limit', 'stop', 'stop_limit']),
  body('quantity').isFloat({ min: 0.0001 }),
  body('price').optional().isFloat({ min: 0 }),
  body('timeInForce').optional().isIn(['GTC', 'IOC', 'FOK'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const order = await tradingEngine.placeOrder({
      userId: req.user.id,
      ...req.body
    });

    res.status(201).json(order);

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get user orders
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const { status = 'all', symbol, limit = 50 } = req.query;
    
    let query = 'SELECT * FROM orders WHERE user_id = $1';
    const params = [req.user.id];

    if (status !== 'all') {
      query += ` AND status = $${params.length + 1}`;
      params.push(status);
    }

    if (symbol) {
      query += ` AND symbol = $${params.length + 1}`;
      params.push(symbol);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const orders = await pool.query(query, params);
    res.json(orders.rows);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel order
router.delete('/orders/:orderId', authenticateToken, async (req, res) => {
  try {
    const result = await tradingEngine.cancelOrder(req.params.orderId, req.user.id);
    res.json(result);

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get positions
router.get('/positions', authenticateToken, async (req, res) => {
  try {
    const positions = await pool.query(
      `SELECT p.*, m.price as current_price 
       FROM positions p
       LEFT JOIN market_data m ON p.symbol = m.symbol
       WHERE p.user_id = $1 AND p.status = 'open'`,
      [req.user.id]
    );

    // Calculate unrealized PnL
    const positionsWithPnL = positions.rows.map(pos => {
      const currentPrice = parseFloat(pos.current_price) || pos.entry_price;
      const unrealizedPnL = pos.side === 'long' 
        ? (currentPrice - pos.entry_price) * pos.quantity
        : (pos.entry_price - currentPrice) * pos.quantity;
      
      return {
        ...pos,
        unrealized_pnl: unrealizedPnL,
        liquidation_price: pos.liquidation_price || (pos.side === 'long' 
          ? pos.entry_price * 0.9 
          : pos.entry_price * 1.1)
      };
    });

    res.json(positionsWithPnL);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;