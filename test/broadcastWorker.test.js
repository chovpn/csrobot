const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getTelegramDeliveryError,
  runBroadcastDelivery
} = require('../lib/broadcastWorker');

test('broadcast worker classifies blocked and missing Telegram users as permanent', () => {
  assert.equal(getTelegramDeliveryError({ code: 403, description: 'Forbidden: bot was blocked by the user' }).permanent, true);
  assert.equal(getTelegramDeliveryError({ code: 400, description: 'Bad Request: chat not found' }).permanent, true);
  assert.equal(getTelegramDeliveryError({ code: 500, description: 'Internal Server Error' }).permanent, false);
});

test('broadcast worker continues after permanent and temporary recipient errors', async () => {
  const delivered = [];
  const observed = [];
  const result = await runBroadcastDelivery({
    recipients: [1, 2, 3, 3],
    concurrency: 2,
    intervalMs: 0,
    timeoutMs: 1000,
    maxRetries: 0,
    deliver: async (recipient) => {
      delivered.push(recipient);
      if (recipient === 2) throw { code: 403, description: 'Forbidden: bot was blocked by the user' };
      if (recipient === 3) throw { code: 500, description: 'Internal Server Error' };
    },
    onResult: async (item) => {
      observed.push(item);
    }
  });

  assert.deepEqual(delivered.sort(), [1, 2, 3]);
  assert.equal(observed.length, 3);
  assert.deepEqual(result, {
    total: 3,
    ok: 1,
    fail: 2,
    unreachable: 1,
    timeout: 0
  });
});

test('broadcast worker retries Telegram rate limits once', async () => {
  let attempts = 0;
  const result = await runBroadcastDelivery({
    recipients: [10],
    concurrency: 1,
    intervalMs: 0,
    timeoutMs: 1000,
    maxRetries: 1,
    sleep: async () => {},
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 1 }
        };
      }
    }
  });

  assert.equal(attempts, 2);
  assert.equal(result.ok, 1);
  assert.equal(result.fail, 0);
});

test('broadcast worker aborts a stalled recipient without stopping the batch', async () => {
  const result = await runBroadcastDelivery({
    recipients: [20, 21],
    concurrency: 2,
    intervalMs: 0,
    timeoutMs: 100,
    maxRetries: 0,
    deliver: async (recipient, { signal }) => {
      if (recipient === 21) return;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('Request aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
  });

  assert.equal(result.ok, 1);
  assert.equal(result.fail, 1);
  assert.equal(result.timeout, 1);
});
