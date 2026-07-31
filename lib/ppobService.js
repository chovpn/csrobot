const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://api.digiflazz.com';
const PRICE_LIST_TTL_MS = 15 * 60 * 1000;
const SHARED_LOCK_WAIT_MS = 45 * 1000;
const SHARED_LOCK_STALE_MS = 2 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
let priceListCache = { key: '', storedAt: 0, products: [] };

function clearCache() {
  priceListCache = { key: '', storedAt: 0, products: [] };
}

function requireConfig(config = {}) {
  const username = String(config.username || process.env.DIGIFLAZZ_USERNAME || '').trim();
  const apiKey = String(config.apiKey || process.env.DIGIFLAZZ_API_KEY || '').trim();
  const baseUrl = String(config.baseUrl || process.env.DIGIFLAZZ_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!username || !apiKey) {
    throw new Error('DIGIFLAZZ_USERNAME dan DIGIFLAZZ_API_KEY belum diisi.');
  }
  return { username, apiKey, baseUrl };
}

function md5(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSharedCachePaths(configInput, config) {
  const dir = String(configInput.sharedCacheDir || '').trim();
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const key = sha256(`${config.baseUrl.toLowerCase()}|${config.username.toLowerCase()}`).slice(0, 32);
  return {
    cache: path.join(dir, `${key}.json`),
    lock: path.join(dir, `${key}.lock`),
    cooldown: path.join(dir, `${key}.cooldown.json`)
  };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readSharedProducts(cachePath, maxAgeMs, markupFee) {
  const cached = readJsonFile(cachePath);
  const storedAt = Number(cached?.storedAt || 0);
  const products = Array.isArray(cached?.products) ? cached.products : [];
  if (!storedAt || !products.length || Date.now() - storedAt > maxAgeMs) return null;
  return {
    storedAt,
    products: products.map((product) => ({
      ...product,
      price: calculatePrice(product.buyerPrice, markupFee)
    }))
  };
}

function writeJsonAtomic(filePath, payload) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readRateLimitCooldown(cooldownPath) {
  const data = readJsonFile(cooldownPath);
  const retryAfter = Number(data?.retryAfter || 0);
  if (!retryAfter || retryAfter <= Date.now()) {
    try { fs.unlinkSync(cooldownPath); } catch (_) {}
    return null;
  }
  return {
    retryAfter,
    message: String(data?.message || 'Pengecekan pricelist sedang terkena rate limit.')
  };
}

function isPriceListRateLimit(error) {
  return /limitasi.*pricelist|pricelist.*limit|rate.?limit/i.test(String(error?.message || error || ''));
}

async function acquireFileLock(lockPath) {
  const deadline = Date.now() + SHARED_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
      return () => {
        try { fs.closeSync(fd); } catch (_) {}
        try { fs.unlinkSync(lockPath); } catch (_) {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > SHARED_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (_) {}
      await sleep(400 + Math.floor(Math.random() * 250));
    }
  }
  return null;
}

function normalizeInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const text = String(value ?? '').trim();
  if (!text || !/^-?\d+$/.test(text)) return null;
  return Number(text);
}

function calculatePrice(basePrice, markupFee = 0) {
  const price = normalizeInt(basePrice);
  const fee = Math.max(0, normalizeInt(markupFee) || 0);
  if (price === null || price < 0) return null;
  return price + fee;
}

function normalizeBool(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'aktif', 'active', 'normal'].includes(text)) return true;
  if (['0', 'false', 'no', 'nonaktif', 'inactive', 'gangguan'].includes(text)) return false;
  return Boolean(value);
}

function normalizeProduct(product = {}, markupFee = 0) {
  const buyerSkuCode = String(product.buyer_sku_code || product.buyerSkuCode || '').trim();
  const buyerPrice = normalizeInt(product.price ?? product.buyer_price ?? product.buyerPrice);
  const price = calculatePrice(buyerPrice, markupFee);
  const buyerActive = normalizeBool(product.buyer_product_status ?? product.buyerProductStatus ?? true);
  const sellerActive = normalizeBool(product.seller_product_status ?? product.sellerProductStatus ?? true);
  return {
    buyerSkuCode,
    productName: String(product.product_name || product.productName || buyerSkuCode).trim(),
    brand: String(product.brand || 'Lainnya').trim() || 'Lainnya',
    category: String(product.category || 'Lainnya').trim() || 'Lainnya',
    type: String(product.type || 'Umum').trim() || 'Umum',
    buyerPrice,
    price,
    stock: normalizeInt(product.stock),
    isActive: Boolean(buyerSkuCode && buyerActive && sellerActive && price !== null),
    raw: product
  };
}

async function digiflazzPost(path, body, config) {
  const response = await axios.post(`${config.baseUrl}${path}`, body, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    timeout: 30000
  });
  return response.data || {};
}

async function fetchPriceList(configInput = {}, options = {}) {
  const now = Date.now();
  const markupFee = Math.max(0, normalizeInt(configInput.markupFee) || 0);
  const config = requireConfig(configInput);
  const cacheKey = sha256(`${config.baseUrl.toLowerCase()}|${config.username.toLowerCase()}`).slice(0, 32);
  if (
    !options.forceRefresh &&
    priceListCache.key === cacheKey &&
    priceListCache.products.length &&
    now - priceListCache.storedAt < PRICE_LIST_TTL_MS
  ) {
    return priceListCache.products.map((product) => ({ ...product, price: calculatePrice(product.buyerPrice, markupFee) }));
  }

  const sharedPaths = getSharedCachePaths(configInput, config);
  const sharedTtlMs = Math.max(60 * 1000, Number(configInput.sharedCacheTtlMs || PRICE_LIST_TTL_MS));

  if (sharedPaths && !options.bypassSharedCache) {
    const cached = readSharedProducts(sharedPaths.cache, sharedTtlMs, markupFee);
    if (cached) {
      priceListCache = { key: cacheKey, storedAt: cached.storedAt, products: cached.products.map((product) => ({ ...product })) };
      return cached.products;
    }
    const cooldown = readRateLimitCooldown(sharedPaths.cooldown);
    if (cooldown) {
      const waitSeconds = Math.max(1, Math.ceil((cooldown.retryAfter - Date.now()) / 1000));
      throw new Error(`${cooldown.message} Coba lagi dalam ${waitSeconds} detik.`);
    }
  }

  const releaseLock = sharedPaths ? await acquireFileLock(sharedPaths.lock) : null;
  if (sharedPaths && !releaseLock) {
    const cached = readSharedProducts(sharedPaths.cache, sharedTtlMs, markupFee);
    if (cached) {
      priceListCache = { key: cacheKey, storedAt: cached.storedAt, products: cached.products.map((product) => ({ ...product })) };
      return cached.products;
    }
    throw new Error('Sync pricelist sedang dijalankan bot lain. Silakan coba beberapa saat lagi.');
  }

  try {
    if (sharedPaths && !options.bypassSharedCache) {
      const cached = readSharedProducts(sharedPaths.cache, sharedTtlMs, markupFee);
      if (cached) {
        priceListCache = { key: cacheKey, storedAt: cached.storedAt, products: cached.products.map((product) => ({ ...product })) };
        return cached.products;
      }
      const cooldown = readRateLimitCooldown(sharedPaths.cooldown);
      if (cooldown) {
        const waitSeconds = Math.max(1, Math.ceil((cooldown.retryAfter - Date.now()) / 1000));
        throw new Error(`${cooldown.message} Coba lagi dalam ${waitSeconds} detik.`);
      }
    }

    const body = {
      cmd: 'prepaid',
      username: config.username,
      sign: md5(`${config.username}${config.apiKey}pricelist`)
    };
    const payload = await digiflazzPost('/v1/price-list', body, config);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!rows.length) {
      throw new Error(payload?.data?.message || payload?.message || 'Price list Digiflazz kosong.');
    }
    const products = rows
      .map((row) => normalizeProduct(row, markupFee))
      .filter((product) => product.isActive);
    const storedAt = Date.now();
    priceListCache = {
      key: cacheKey,
      storedAt,
      products: products.map((product) => ({ ...product }))
    };
    if (sharedPaths) {
      writeJsonAtomic(sharedPaths.cache, {
        storedAt,
        products: products.map((product) => ({ ...product }))
      });
      try { fs.unlinkSync(sharedPaths.cooldown); } catch (_) {}
    }
    return products;
  } catch (error) {
    if (sharedPaths && isPriceListRateLimit(error)) {
      writeJsonAtomic(sharedPaths.cooldown, {
        createdAt: Date.now(),
        retryAfter: Date.now() + RATE_LIMIT_COOLDOWN_MS,
        message: String(error.message || error)
      });
    }
    throw error;
  } finally {
    if (releaseLock) releaseLock();
  }
}

function uniqueSorted(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'id-ID'));
}

async function getCatalog(config, options = {}) {
  const products = await fetchPriceList(config, options);
  return {
    products,
    categories: uniqueSorted(products.map((product) => product.category)),
    brands: uniqueSorted(products.map((product) => product.brand)),
    types: uniqueSorted(products.map((product) => product.type))
  };
}

function filterProducts(products, filters = {}) {
  const category = String(filters.category || '').trim();
  const brand = String(filters.brand || '').trim();
  const type = String(filters.type || '').trim();
  return products.filter((product) => {
    if (category && product.category !== category) return false;
    if (brand && product.brand !== brand) return false;
    if (type && product.type !== type) return false;
    return true;
  });
}

function findProduct(products, sku) {
  const target = String(sku || '').trim().toLowerCase();
  return products.find((product) => String(product.buyerSkuCode || '').toLowerCase() === target) || null;
}

function mapDigiflazzStatus(status) {
  const text = String(status || '').trim().toLowerCase();
  if (['sukses', 'success', 'berhasil'].includes(text)) return 'SUCCESS';
  if (['gagal', 'failed', 'fail'].includes(text)) return 'FAILED';
  return 'PROCESS';
}

async function createTransaction(configInput = {}, order = {}) {
  const config = requireConfig(configInput);
  const buyerSkuCode = String(order.buyerSkuCode || '').trim();
  const customerNo = String(order.customerNo || '').trim();
  const refId = String(order.refId || '').trim();
  if (!buyerSkuCode || !customerNo || !refId) {
    throw new Error('buyerSkuCode, customerNo, dan refId wajib diisi.');
  }
  const body = {
    username: config.username,
    buyer_sku_code: buyerSkuCode,
    customer_no: customerNo,
    ref_id: refId,
    sign: md5(`${config.username}${config.apiKey}${refId}`)
  };
  if (order.maxPrice) body.max_price = Number(order.maxPrice);
  const payload = await digiflazzPost('/v1/transaction', body, config);
  const data = payload?.data || {};
  return {
    payload,
    data,
    status: mapDigiflazzStatus(data.status),
    message: data.message || payload?.message || '',
    serialNumber: data.sn || data.serial_number || ''
  };
}

async function checkBalance(configInput = {}) {
  const config = requireConfig(configInput);
  const body = {
    cmd: 'deposit',
    username: config.username,
    sign: md5(`${config.username}${config.apiKey}depo`)
  };
  const payload = await digiflazzPost('/v1/cek-saldo', body, config);
  const deposit = normalizeInt(payload?.data?.deposit);
  if (deposit === null) {
    throw new Error(payload?.data?.message || payload?.message || 'Saldo Digiflazz tidak bisa dibaca.');
  }
  return {
    balance: deposit,
    payload
  };
}

module.exports = {
  clearCache,
  calculatePrice,
  getCatalog,
  filterProducts,
  findProduct,
  createTransaction,
  checkBalance,
  mapDigiflazzStatus
};
