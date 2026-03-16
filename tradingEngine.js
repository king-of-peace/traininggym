// services/tradingEngine.js
const { EventEmitter } = require('events');
const { Decimal } = require('@prisma/client/runtime/library');
const { pool } = require(' ../config/database');
const { io } = require('../app'); // Assuming io is exported from app.js

class TradingEngine extends EventEmitter {
  constructor() {
    super();
    this.orderBooks = new Map();
    this.initialized = false;
    this.FEE_RATE = new Decimal('0.001');
    this.io = io; // Store reference
  }

  async initialize() {
    try {
      const result = await pool.query(
        "SELECT * FROM orders WHERE status IN ('open', 'partially_filled') ORDER BY created_at ASC"
      );

      for (const order of result.rows) {
        this.addToOrderBook(order);
      }

      this.initialized = true;
      console.log(`Trading engine initialized with ${result.rowCount} open orders`);
    } catch (error) {
      console.error('Failed to initialize trading engine:', error);
      throw error;
    }
  }

  async placeOrder(orderData) {
    const {
      userId,
      symbol,
      side,
      type,
      quantity,
      price,
      stopPrice,
      timeInForce = 'GTC'
    } = orderData;

    // Validation
    if (!quantity || new Decimal(quantity).lessThanOrEqualTo(0)) {
      throw new Error('Quantity must be greater than 0');
    }

    if ((type === 'LIMIT' || type === 'STOP_LIMIT') && (!price || new Decimal(price).lessThanOrEqualTo(0))) {
      throw new Error('Limit price required for limit orders');
    }

    if (!userId || !symbol || !side || !type) {
      throw new Error('Missing required order parameters');
    }

    // Risk checks
    await this.performRiskChecks(userId, symbol, side, quantity, price);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check and lock funds
      const [baseCurrency, quoteCurrency] = symbol.split('-');
      
      if (side === 'BUY') {
        const requiredFunds = type === 'MARKET'
          ? await this.estimateMarketOrderCost(symbol, quantity)
          : new Decimal(price).mul(quantity);

        const balance = await client.query(
          'SELECT available FROM balances WHERE user_id = $1 AND currency = $2',
          [userId, quoteCurrency]
        );

        if (!balance.rows[0] || new Decimal(balance.rows[0].available).lessThan(requiredFunds)) {
          throw new Error(`Insufficient ${quoteCurrency} balance`);
        }

        await client.query(
          `UPDATE balances 
           SET available = available - $1, held = held + $1 
           WHERE user_id = $2 AND currency = $3`,
          [requiredFunds.toNumber(), userId, quoteCurrency]
        );
      } else {
        // SELL
        const balance = await client.query(
          'SELECT available FROM balances WHERE user_id = $1 AND currency = $2',
          [userId, baseCurrency]
        );

        if (!balance.rows[0] || new Decimal(balance.rows[0].available).lessThan(quantity)) {
          throw new Error(`Insufficient ${baseCurrency} balance`);
        }

        await client.query(
          `UPDATE balances 
           SET available = available - $1, held = held + $1 
           WHERE user_id = $2 AND currency = $3`,
          [quantity, userId, baseCurrency]
        );
      }

      // Create order
      const orderResult = await client.query(
        `INSERT INTO orders (user_id, symbol, side, type, quantity, price, stop_price, time_in_force, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [userId, symbol, side, type, quantity, price, stopPrice, timeInForce, type === 'MARKET' ? 'PENDING' : 'OPEN']
      );

      const order = orderResult.rows[0];

      // Match order immediately if market order or crossing limit
      if (type === 'MARKET' || this.isCrossingLimit(order)) {
        await this.matchOrder(order, client);
      } else {
        this.addToOrderBook(order);
      }

      await client.query('COMMIT');

      // Emit events
      this.emit('order:created', order);
      if (this.io) {
        this.io.to(`user:${userId}`).emit('order:update', order);
      }

      return order;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async matchOrder(order, client) {
    const book = this.orderBooks.get(order.symbol);
    if (!book) return [];

    const oppositeSide = order.side === 'BUY' ? 'asks' : 'bids';
    const oppositeOrders = book[oppositeSide];
    
    let remainingQty = new Decimal(order.quantity).minus(new Decimal(order.filled_quantity || 0));
    const trades = [];

    for (let i = 0; i < oppositeOrders.length && remainingQty.greaterThan(0); i++) {
      const match = oppositeOrders[i];
      
      // Price validation for limit orders
      if (order.type === 'LIMIT' && order.price) {
        const orderPrice = new Decimal(order.price);
        if (order.side === 'BUY' && match.price.greaterThan(orderPrice)) break;
        if (order.side === 'SELL' && match.price.lessThan(orderPrice)) break;
      }

      const fillQty = Decimal.min(remainingQty, match.quantity);
      const fillPrice = match.price;
      const totalValue = fillQty.mul(fillPrice);
      const fee = totalValue.mul(this.FEE_RATE);

      // Create trade record
      const tradeResult = await client.query(
        `INSERT INTO trades (order_id, user_id, symbol, side, quantity, price, fee, fee_currency, is_maker)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [order.id, order.user_id, order.symbol, order.side, fillQty.toNumber(), 
         fillPrice.toNumber(), fee.toNumber(), order.symbol.split('-')[1], false]
      );

      // Update counterparty trade
      await client.query(
        `INSERT INTO trades (order_id, user_id, symbol, side, quantity, price, fee, fee_currency, is_maker)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [match.id, match.userId, order.symbol, order.side === 'BUY' ? 'SELL' : 'BUY', 
         fillQty.toNumber(), fillPrice.toNumber(), fee.toNumber(), 
         order.symbol.split('-')[1], true]
      );

      // Update order status
      const newFilledQty = new Decimal(order.filled_quantity || 0).plus(fillQty);
      const isFilled = newFilledQty.greaterThanOrEqualTo(order.quantity);
      
      await client.query(
        `UPDATE orders 
         SET filled_quantity = $1, 
             status = $2,
             filled_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE filled_at END
         WHERE id = $4`,
        [newFilledQty.toNumber(), isFilled ? 'FILLED' : 'PARTIALLY_FILLED', isFilled, order.id]
      );

      // Update counterparty order
      const matchOrderResult = await client.query('SELECT * FROM orders WHERE id = $1', [match.id]);
      const matchOrder = matchOrderResult.rows[0];
      
      const matchFilledQty = new Decimal(matchOrder.filled_quantity || 0).plus(fillQty);
      const isMatchFilled = matchFilledQty.greaterThanOrEqualTo(matchOrder.quantity);
      
      await client.query(
        `UPDATE orders 
         SET filled_quantity = $1, status = $2
         WHERE id = $3`,
        [matchFilledQty.toNumber(), isMatchFilled ? 'FILLED' : 'PARTIALLY_FILLED', match.id]
      );

      // Update balances
      await this.updateBalances(order, match, fillQty, fillPrice, fee, client);

      trades.push(tradeResult.rows[0]);
      
      remainingQty = remainingQty.minus(fillQty);
      match.quantity = match.quantity.minus(fillQty);

      // Emit trade event
      this.emit('trade:executed', {
        symbol: order.symbol,
        price: fillPrice.toNumber(),
        quantity: fillQty.toNumber(),
        side: order.side,
        timestamp: new Date()
      });

      if (this.io) {
        this.io.to(`market:${order.symbol}`).emit('trade', {
          price: fillPrice.toNumber(),
          quantity: fillQty.toNumber(),
          side: order.side,
          time: Date.now()
        });
      }

      // Remove filled orders from book
      if (match.quantity.lessThanOrEqualTo(0)) {
        oppositeOrders.splice(i, 1);
        i--;
      }
    }

    // Handle unfilled market orders
    if (remainingQty.greaterThan(0) && order.type === 'MARKET') {
      if (order.time_in_force === 'IOC' || order.time_in_force === 'FOK') {
        await this.releaseRemainingFunds(order, remainingQty, client);
        
        await client.query(
          "UPDATE orders SET status = 'CANCELLED' WHERE id = $1",
          [order.id]
        );
      }
    }

    return trades;
  }

  async updateBalances(order, match, quantity, price, fee, client) {
    const [baseCurrency, quoteCurrency] = order.symbol.split('-');
    const total = quantity.mul(price);

    try {
      if (order.side === 'BUY') {
        // Buyer: Release held quote, receive base
        await client.query(
          `UPDATE balances 
           SET held = held - $1, total = total - $2 
           WHERE user_id = $3 AND currency = $4`,
          [total.plus(fee).toNumber(), fee.toNumber(), order.user_id, quoteCurrency]
        );
        
        await client.query(
          `INSERT INTO balances (user_id, currency, available, total)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (user_id, currency) 
           DO UPDATE SET available = balances.available + $3, total = balances.total + $3`,
          [order.user_id, baseCurrency, quantity.toNumber()]
        );

        // Seller: Release held base, receive quote
        await client.query(
          `UPDATE balances 
           SET held = held - $1, available = available + $2, total = total + $2 
           WHERE user_id = $3 AND currency = $4`,
          [quantity.toNumber(), total.minus(fee).toNumber(), match.userId, quoteCurrency]
        );
      } else {
        // SELL side
        await client.query(
          `UPDATE balances 
           SET held = held - $1, total = total - $1 
           WHERE user_id = $2 AND currency = $3`,
          [quantity.toNumber(), order.user_id, baseCurrency]
        );

        await client.query(
          `INSERT INTO balances (user_id, currency, available, total)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (user_id, currency) 
           DO UPDATE SET available = balances.available + $3, total = balances.total + $3`,
          [order.user_id, quoteCurrency, total.minus(fee).toNumber()]
        );

        // Buyer side of match
        await client.query(
          `UPDATE balances 
           SET held = held - $1 
           WHERE user_id = $2 AND currency = $3`,
          [total.plus(fee).toNumber(), match.userId, quoteCurrency]
        );

        await client.query(
          `INSERT INTO balances (user_id, currency, available, total)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (user_id, currency) 
           DO UPDATE SET available = balances.available + $3, total = balances.total + $3`,
          [match.userId, baseCurrency, quantity.toNumber()]
        );
      }
    } catch (error) {
      console.error('Balance update error:', error);
      throw new Error('Failed to update balances');
    }
  }

  async performRiskChecks(userId, symbol, side, quantity, price) {
    const user = await pool.query(
      'SELECT is_active, kyc_status, account_tier FROM users WHERE id = $1',
      [userId]
    );

    if (!user.rows[0] || !user.rows[0].is_active) {
      throw new Error('Account is not active');
    }

    if (user.rows[0].kyc_status !== 'VERIFIED') {
      throw new Error('KYC verification required for trading');
    }

    const positionLimits = {
      BASIC: 10000,
      SILVER: 50000,
      GOLD: 250000,
      PLATINUM: 1000000,
      INSTITUTIONAL: 10000000
    };

    const limit = positionLimits[user.rows[0].account_tier] || 10000;
    const orderValue = price ? new Decimal(price).mul(quantity) : new Decimal(quantity).mul(100);

    if (orderValue.greaterThan(limit)) {
      throw new Error(`Order exceeds ${user.rows[0].account_tier} tier limit of $${limit}`);
    }
  }

  addToOrderBook(order) {
    if (!this.orderBooks.has(order.symbol)) {
      this.orderBooks.set(order.symbol, { bids: [], asks: [] });
    }

    const book = this.orderBooks.get(order.symbol);
    const side = order.side === 'BUY' ? 'bids' : 'asks';
    
    book[side].push({
      id: order.id,
      userId: order.user_id,
      price: new Decimal(order.price || 0),
      quantity: new Decimal(order.quantity).minus(new Decimal(order.filled_quantity || 0)),
      originalQuantity: new Decimal(order.quantity),
      type: order.type,
      createdAt: order.created_at
    });

    // Sort: bids descending, asks ascending
    book.bids.sort((a, b) => b.price.comparedTo(a.price));
    book.asks.sort((a, b) => a.price.comparedTo(b.price));
  }

  isCrossingLimit(order) {
    if (order.type !== 'LIMIT' || !order.price) return false;
    
    const book = this.orderBooks.get(order.symbol);
    if (!book) return false;

    const orderPrice = new Decimal(order.price);

    if (order.side === 'BUY' && book.asks.length > 0) {
      return orderPrice.greaterThanOrEqualTo(book.asks[0].price);
    } else if (order.side === 'SELL' && book.bids.length > 0) {
      return orderPrice.lessThanOrEqualTo(book.bids[0].price);
    }
    return false;
  }

  async estimateMarketOrderCost(symbol, quantity) {
    const book = this.orderBooks.get(symbol);
    if (!book || book.asks.length === 0) {
      throw new Error('No liquidity available for market order');
    }

    let cost = new Decimal(0);
    let remaining = new Decimal(quantity);
    
    for (const ask of book.asks) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const fillQty = Decimal.min(remaining, ask.quantity);
      cost = cost.plus(fillQty.mul(ask.price));
      remaining = remaining.minus(fillQty);
    }

    if (remaining.greaterThan(0)) {
      throw new Error('Insufficient liquidity for market order');
    }

    return cost.mul(1.001);
  }

  async releaseRemainingFunds(order, remainingQty, client) {
    const [baseCurrency, quoteCurrency] = order.symbol.split('-');
    
    if (order.side === 'BUY' && order.price) {
      const releaseAmount = remainingQty.mul(order.price);
      await client.query(
        `UPDATE balances 
         SET available = available + $1, held = held - $1 
         WHERE user_id = $2 AND currency = $3`,
        [releaseAmount.toNumber(), order.user_id, quoteCurrency]
      );
    } else {
      await client.query(
        `UPDATE balances 
         SET available = available + $1, held = held - $1 
         WHERE user_id = $2 AND currency = $3`,
        [remainingQty.toNumber(), order.user_id, baseCurrency]
      );
    }
  }

  async cancelOrder(orderId, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orderResult = await client.query(
        'SELECT * FROM orders WHERE id = $1 AND user_id = $2 AND status IN ($3, $4)',
        [orderId, userId, 'OPEN', 'PARTIALLY_FILLED']
      );

      if (orderResult.rows.length === 0) {
        throw new Error('Order not found or cannot be cancelled');
      }

      const order = orderResult.rows[0];
      const remainingQty = new Decimal(order.quantity).minus(new Decimal(order.filled_quantity || 0));

      // Release holdings
      await this.releaseRemainingFunds(order, remainingQty, client);

      // Update order status
      await client.query(
        "UPDATE orders SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [orderId]
      );

      // Remove from order book
      const book = this.orderBooks.get(order.symbol);
      if (book) {
        const side = order.side === 'BUY' ? 'bids' : 'asks';
        const idx = book[side].findIndex(o => o.id === orderId);
        if (idx !== -1) book[side].splice(idx, 1);
      }

      await client.query('COMMIT');

      this.emit('order:cancelled', order);
      if (this.io) {
        this.io.to(`user:${userId}`).emit('order:update', { ...order, status: 'CANCELLED' });
      }

      return { success: true };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  getOrderBook(symbol, depth = 20) {
    const book = this.orderBooks.get(symbol);
    if (!book) return { bids: [], asks: [] };

    const aggregate = (entries) => {
      const levels = new Map();
      
      for (const entry of entries) {
        const price = entry.price.toNumber();
        if (!levels.has(price)) {
          levels.set(price, { price: entry.price, quantity: new Decimal(0), count: 0 });
        }
        const level = levels.get(price);
        level.quantity = level.quantity.plus(entry.quantity);
        level.count++;
      }

      return Array.from(levels.values())
        .slice(0, depth)
        .map(l => ({
          price: l.price.toNumber(),
          quantity: l.quantity.toNumber(),
          total: l.price.mul(l.quantity).toNumber(),
          orderCount: l.count
        }));
    };

    return {
      bids: aggregate(book.bids.slice(0, depth * 2)),
      asks: aggregate(book.asks.slice(0, depth * 2))
    };
  }
}

module.exports = { TradingEngine };