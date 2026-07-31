function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function getTelegramDeliveryError(error) {
  const code = Number(
    error?.code ||
    error?.response?.error_code ||
    error?.response?.statusCode ||
    0
  );
  const description = String(
    error?.description ||
    error?.response?.description ||
    error?.message ||
    error ||
    'Unknown Telegram error'
  );
  const retryAfter = Math.max(
    0,
    Number(
      error?.parameters?.retry_after ||
      error?.response?.parameters?.retry_after ||
      0
    ) || 0
  );
  const permanent =
    code === 403 ||
    (
      code === 400 &&
      /(chat not found|user is deactivated|bot was blocked|bot can't initiate conversation|chat_id is empty)/i.test(description)
    );

  return {
    code,
    description: description.slice(0, 500),
    retryAfter,
    permanent,
    timeout: error?.name === 'AbortError' || /aborted|timed?\s*out/i.test(description)
  };
}

function createRateLimiter(intervalMs, sleep = sleepMs) {
  const interval = Math.max(0, Number(intervalMs) || 0);
  let nextAt = 0;
  let tail = Promise.resolve();

  return async function waitForSlot() {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const waitMs = Math.max(0, nextAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      nextAt = Date.now() + interval;
    } finally {
      release();
    }
  };
}

async function runBroadcastDelivery(options = {}) {
  const recipients = Array.from(new Set(
    (Array.isArray(options.recipients) ? options.recipients : [])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value !== 0)
  ));
  const deliver = options.deliver;
  if (typeof deliver !== 'function') throw new Error('Broadcast deliver function wajib diisi.');

  const concurrency = Math.max(1, Math.min(20, Number(options.concurrency) || 4));
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 15000);
  const maxRetriesInput = options.maxRetries === undefined ? 1 : Number(options.maxRetries);
  const maxRetries = Math.max(0, Math.min(3, Number.isFinite(maxRetriesInput) ? maxRetriesInput : 1));
  const sleep = typeof options.sleep === 'function' ? options.sleep : sleepMs;
  const waitForSlot = typeof options.waitForSlot === 'function'
    ? options.waitForSlot
    : createRateLimiter(options.intervalMs ?? 60, sleep);
  const onResult = typeof options.onResult === 'function' ? options.onResult : null;
  const results = {
    total: recipients.length,
    ok: 0,
    fail: 0,
    unreachable: 0,
    timeout: 0
  };
  let cursor = 0;

  async function deliverOne(recipient) {
    let attempt = 0;
    while (true) {
      attempt += 1;
      await waitForSlot();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await deliver(recipient, { signal: controller.signal, attempt });
        return { recipient, ok: true, attempt };
      } catch (error) {
        const details = getTelegramDeliveryError(error);
        if (details.code === 429 && attempt <= maxRetries) {
          await sleep(Math.max(1000, details.retryAfter * 1000));
          continue;
        }
        return { recipient, ok: false, attempt, error: details };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= recipients.length) return;

      const result = await deliverOne(recipients[index]);
      if (result.ok) {
        results.ok += 1;
      } else {
        results.fail += 1;
        if (result.error?.permanent) results.unreachable += 1;
        if (result.error?.timeout) results.timeout += 1;
      }

      if (onResult) {
        await onResult(result, { ...results }).catch(() => {});
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, recipients.length)) }, () => worker())
  );
  return results;
}

module.exports = {
  createRateLimiter,
  getTelegramDeliveryError,
  runBroadcastDelivery
};
