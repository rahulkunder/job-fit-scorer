/**
 * FIFO queue with a concurrency cap and a token-bucket rate limit.
 *
 * Without this, opening a search page with batch scoring on fires a dozen
 * simultaneous requests and every provider answers 429. The bucket refills
 * continuously (rpm/60 tokens per second) rather than in per-minute steps, so
 * steady browsing never bunches up against a window boundary.
 */

export class Limiter {
  constructor({ rpm = 15, concurrency = 3 } = {}) {
    this.configure({ rpm, concurrency });
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
    this.active = 0;
    this.queue = [];
  }

  configure({ rpm, concurrency }) {
    if (Number.isFinite(rpm) && rpm > 0) {
      this.rpm = rpm;
      this.capacity = Math.max(1, Math.min(rpm, 10));
      this.tokens = Math.min(this.tokens ?? this.capacity, this.capacity);
    }
    if (Number.isFinite(concurrency) && concurrency > 0) {
      this.concurrency = Math.max(1, Math.min(concurrency, 8));
    }
  }

  #refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * (this.rpm / 60));
  }

  /** Milliseconds until at least one token is available. */
  #waitForToken() {
    this.#refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / (this.rpm / 60)) * 1000);
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    if (this.pumpScheduled) return;

    while (this.queue.length && this.active < this.concurrency) {
      const wait = this.#waitForToken();
      if (wait > 0) {
        this.pumpScheduled = true;
        setTimeout(() => {
          this.pumpScheduled = false;
          this.#pump();
        }, wait);
        return;
      }

      this.tokens -= 1;
      const { task, resolve, reject } = this.queue.shift();
      this.active++;

      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          this.active--;
          this.#pump();
        });
    }
  }

  get pending() {
    return this.queue.length + this.active;
  }
}
