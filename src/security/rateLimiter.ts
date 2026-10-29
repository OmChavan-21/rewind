import { NextResponse } from "next/server";

interface RateLimitRecord {
  timestamps: number[];
}

const rateLimitStore = new Map<string, RateLimitRecord>();

// Cleanup stale keys older than 10 minutes every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastCleanup = Date.now();

function purgeStaleRecords(now: number, windowMs: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCleanup = now;
  for (const [key, record] of rateLimitStore.entries()) {
    record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);
    if (record.timestamps.length === 0) {
      rateLimitStore.delete(key);
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  scope: "distributed" | "local";
}

let testDistributedHandler: ((key: string, max: number, window: number) => Promise<RateLimitResult | null>) | null = null;

export function setDistributedHandlerForTesting(
  handler: ((key: string, max: number, window: number) => Promise<RateLimitResult | null>) | null
) {
  testDistributedHandler = handler;
}

/**
 * Executes a distributed rate limit check using Upstash Redis or Vercel KV REST API if configured.
 */
async function checkDistributedRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult | null> {
  if (testDistributedHandler) {
    try {
      return await testDistributedHandler(key, maxRequests, windowMs);
    } catch {
      return null;
    }
  }

  const restUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (!restUrl || !restToken) {
    return null;
  }

  const now = Date.now();
  const clearBefore = now - windowMs;
  const expireSeconds = Math.ceil(windowMs / 1000);

  try {
    const pipelineUrl = `${restUrl.replace(/\/$/, "")}/pipeline`;
    const res = await fetch(pipelineUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${restToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["ZREMRANGEBYSCORE", key, "0", String(clearBefore)],
        ["ZCARD", key],
        ["ZADD", key, String(now), String(now)],
        ["EXPIRE", key, String(expireSeconds)],
      ]),
      // 1-second timeout so edge functions never hang on rate limiter
      signal: AbortSignal.timeout(1000),
    });

    if (!res.ok) {
      return null;
    }

    const json = await res.json();
    // json structure from pipeline: [{ result: removedCount }, { result: currentCountBeforeAdd }, ...]
    const currentCount = typeof json[1]?.result === "number" ? json[1].result : 0;

    if (currentCount >= maxRequests) {
      return {
        allowed: false,
        limit: maxRequests,
        remaining: 0,
        retryAfterSeconds: Math.ceil(windowMs / 1000),
        scope: "distributed",
      };
    }

    return {
      allowed: true,
      limit: maxRequests,
      remaining: Math.max(0, maxRequests - (currentCount + 1)),
      retryAfterSeconds: 0,
      scope: "distributed",
    };
  } catch {
    // If distributed check fails, fall back cleanly to local sliding window
    return null;
  }
}

/**
 * Checks in-memory sliding window rate limit for a given key.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  purgeStaleRecords(now, windowMs);

  let record = rateLimitStore.get(key);
  if (!record) {
    record = { timestamps: [] };
    rateLimitStore.set(key, record);
  }

  // Filter out timestamps outside the active window
  record.timestamps = record.timestamps.filter((ts) => now - ts < windowMs);

  if (record.timestamps.length >= maxRequests) {
    const oldestTimestamp = record.timestamps[0];
    const retryAfterMs = oldestTimestamp + windowMs - now;
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

    return {
      allowed: false,
      limit: maxRequests,
      remaining: 0,
      retryAfterSeconds,
      scope: "local",
    };
  }

  record.timestamps.push(now);

  return {
    allowed: true,
    limit: maxRequests,
    remaining: maxRequests - record.timestamps.length,
    retryAfterSeconds: 0,
    scope: "local",
  };
}

/**
 * Clears the rate limiter store (useful for unit tests).
 */
export function clearRateLimitStore(): void {
  rateLimitStore.clear();
}

/**
 * Extracts client IP address safely from request headers.
 *
 * Trust Model & Platform Assumptions:
 * 1. Platform-Trusted Header (`x-real-ip`):
 *    On Vercel (our production target), the edge router terminates client connections,
 *    strips any incoming client-provided `x-real-ip`, and sets `x-real-ip` directly
 *    to the remote client IP. This header cannot be forged by external clients on Vercel
 *    and is therefore given top priority.
 *
 * 2. Vercel-Specific Proxy Header (`x-vercel-forwarded-for`):
 *    If `x-real-ip` is absent, Vercel also provides `x-vercel-forwarded-for`.
 *
 * 3. General Proxy Header (`x-forwarded-for`):
 *    When requests pass through standard reverse proxies, each proxy appends the remote
 *    address to the end of the `x-forwarded-for` list. If a client sends a spoofed
 *    `X-Forwarded-For: <fake-ip>`, a single reverse proxy forwards `<fake-ip>, <real-ip>`.
 *    Taking the leftmost IP (`split(",")[0]`) is vulnerable to spoofing because an attacker
 *    can rotate the first IP to bypass rate limits. When platform headers are missing,
 *    we take the rightmost non-empty IP (the address appended by the nearest proxy hop).
 *
 * 4. Limitations & Conservative Fallback:
 *    Without platform-guaranteed header sanitization or a cryptographically verified
 *    proxy chain, HTTP headers can never be 100% proven against direct-to-origin spoofing.
 *    If no valid IP header is found or parsing fails, we fall back to "127.0.0.1".
 */
export function extractClientIp(request: Request): string {
  // 1. Check platform-trusted single-IP header (Vercel edge router guarantees this)
  const realIp = request.headers.get("x-real-ip");
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }

  // 2. Check Vercel-specific forwarded header
  const vercelForwarded = request.headers.get("x-vercel-forwarded-for");
  if (vercelForwarded && vercelForwarded.trim().length > 0) {
    const parts = vercelForwarded.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }

  // 3. Check standard x-forwarded-for header
  // Note: Rightmost IP is appended by the most immediate upstream proxy;
  // leftmost IP is attacker-controllable if the client sent an initial X-Forwarded-For header.
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded && forwarded.trim().length > 0) {
    const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }

  // 4. Fallback for direct local calls or missing headers
  return "127.0.0.1";
}

/**
 * Checks whether distributed rate limiting is mandated by the environment.
 */
export function isDistributedRateLimitRequired(): boolean {
  return (
    process.env.REQUIRE_DISTRIBUTED_RATE_LIMIT === "true" ||
    process.env.REWIND_REQUIRE_DISTRIBUTED_RATE_LIMIT === "true"
  );
}

/**
 * Enforces rate limiting on a sensitive route. Supports distributed Vercel KV/Upstash and local in-memory fallback.
 * Fails closed with 503 if distributed rate limiting is required but unavailable.
 */
export async function enforceRateLimitAsync(
  request: Request,
  routeKey: string,
  maxRequests: number = 10,
  windowMs: number = 60 * 1000
): Promise<NextResponse | null> {
  if (process.env.REWIND_DISABLE_RATE_LIMIT === "true") {
    return null;
  }

  const clientIp = extractClientIp(request);
  const key = `ratelimit:${routeKey}:${clientIp}`;

  // Try distributed rate limiter first
  const distributedResult = await checkDistributedRateLimit(key, maxRequests, windowMs);

  // If distributed rate limiting is strictly required but unavailable, fail closed
  if (isDistributedRateLimitRequired() && !distributedResult) {
    return NextResponse.json(
      {
        error: "Distributed rate limiting is required in this environment but is unavailable or misconfigured.",
        code: "RATE_LIMIT_SERVICE_UNAVAILABLE",
      },
      {
        status: 503,
        headers: {
          "Retry-After": "60",
        },
      }
    );
  }

  const result = distributedResult || checkRateLimit(key, maxRequests, windowMs);

  if (!result.allowed) {
    return NextResponse.json(
      {
        error: "Too many requests. Please try again later.",
        retryAfter: result.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(result.retryAfterSeconds),
          "X-RateLimit-Limit": String(result.limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Scope": result.scope,
        },
      }
    );
  }

  return null;
}

/**
 * Synchronous enforceRateLimit for existing callers.
 */
export function enforceRateLimit(
  request: Request,
  routeKey: string,
  maxRequests: number = 10,
  windowMs: number = 60 * 1000
): NextResponse | null {
  if (process.env.REWIND_DISABLE_RATE_LIMIT === "true") {
    return null;
  }

  const clientIp = extractClientIp(request);
  const key = `ratelimit:${routeKey}:${clientIp}`;
  const result = checkRateLimit(key, maxRequests, windowMs);

  if (!result.allowed) {
    return NextResponse.json(
      {
        error: "Too many requests. Please try again later.",
        retryAfter: result.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(result.retryAfterSeconds),
          "X-RateLimit-Limit": String(result.limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Scope": result.scope,
        },
      }
    );
  }

  return null;
}
