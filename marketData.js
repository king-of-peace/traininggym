// services/marketData.js
const { pool, redis } = require(' ../config/database');

class MarketDataService {
  constructor(io) {
    this.io = io;
    this.connections = new Map();
    this.prices = new Map();
    this.intervals = [];
    this.symbols = ['BTC-USD', 'ETH-USD', 'AAPL', 'TSLA', 'GOOGL'];
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      console.warn('Market data service already running');
      return;
    }

    try {
      // Initialize prices
      for (const symbol of this.symbols) {
        this.prices.set(symbol, {
          price: this.getBasePrice(symbol),
          bid: 0,
          ask: 0,
          volume: 0,
          change: 0,
          high: 0,
          low: 0
        });
      }

      // Bind methods to preserve 'this' context
      this.simulationTick = this.simulationTick.bind(this);
      this.persistTick = this.persistTick.bind(this);

      // Start price simulation
      this.intervals.push(setInterval(this.simulationTick, 100));
      
      // Persist to database every 5 seconds
      this.intervals.push(setInterval(this.persistTick, 5000));
      
      this.isRunning = true;
      console.log('Market data service started');
    } catch (error) {
      console.error('Failed to start market data service:', error);
      throw error;
    }
  }

  simulationTick() {
    try {
      for (const [symbol, data] of this.prices) {
        // Random walk
        const change = (Math.random() - 0.5) * (data.price * 0.0002);
        data.price += change;
        data.bid = data.price - 0.01;
        data.ask = data.price + 0.01;
        data.change = (change / data.price) * 100;
        data.volume += Math.random() * 10;

        // Update high/low
        if (data.price > data.high) data.high = data.price;
        if (data.price < data.low || data.low === 0) data.low = data.price;

        // Broadcast to subscribed clients
        if (this.io) {
          this.io.to(`market:${symbol}`).emit('price:update', {
            symbol,
            price: data.price,
            bid: data.bid,
            ask: data.ask,
            change: data.change,
            volume: data.volume,
            high: data.high,
            low: data.low,
            timestamp: Date.now()
          });
        }
      }
    } catch (error) {
      console.error('Error in simulation tick:', error);
    }
  }

  async persistTick() {
    try {
      const values = [];
      const params = [];
      let idx = 1;

      for (const [symbol, data] of this.prices) {
        values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`);
        params.push(
          symbol, 
          data.price, 
          data.bid, 
          data.ask, 
          data.volume, 
          data.change,
          data.high,
          data.low
        );
        idx += 8;
      }

      if (values.length > 0) {
        await pool.query(
          `INSERT INTO market_data (symbol, price, bid, ask, volume_24h, change_24h, high_24h, low_24h)
           VALUES ${values.join(',')}
           ON CONFLICT (symbol) 
           DO UPDATE SET 
             price = EXCLUDED.price, 
             bid = EXCLUDED.bid, 
             ask = EXCLUDED.ask,
             volume_24h = EXCLUDED.volume_24h, 
             change_24h = EXCLUDED.change_24h,
             high_24h = EXCLUDED.high_24h,
             low_24h = EXCLUDED.low_24h,
             updated_at = CURRENT_TIMESTAMP`,
          params
        );
      }
    } catch (error) {
      console.error('Error persisting market data:', error);
      // Don't throw - let simulation continue even if persistence fails
    }
  }

  getBasePrice(symbol) {
    const prices = {
      'BTC-USD': 67234.56,
      'ETH-USD': 3456.78,
      'AAPL': 178.35,
      'TSLA': 245.67,
      'GOOGL': 142.56,
      'MSFT': 378.91,
      'AMZN': 145.23,
      'NVDA': 892.45
    };
    return prices[symbol] || 100;
  }

  getPrice(symbol) {
    return this.prices.get(symbol);
  }

  getAllPrices() {
    return Object.fromEntries(this.prices);
  }

  addSymbol(symbol, basePrice = 100) {
    if (!this.prices.has(symbol)) {
      this.prices.set(symbol, {
        price: basePrice,
        bid: basePrice - 0.01,
        ask: basePrice + 0.01,
        volume: 0,
        change: 0,
        high: basePrice,
        low: basePrice
      });
      this.symbols.push(symbol);
    }
  }

  removeSymbol(symbol) {
    this.prices.delete(symbol);
    this.symbols = this.symbols.filter(s => s !== symbol);
  }

  stop() {
    this.isRunning = false;
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    console.log('Market data service stopped');
  }
}

module.exports = { MarketDataService };