/**
 * Request timing middleware.
 *
 * Logs every API request with its wall-clock duration so you can identify
 * which endpoints are slow in production without a full APM agent.
 *
 * Output format:
 *   [timing] GET /api/ontology/classes?project=…&ontology=… → 200  47.3ms
 *   [timing] GET /api/graph/?mode=classes&limit=1000       → 200 312.1ms  ⚠ SLOW
 *
 * Configuration (environment variables):
 *   TIMING_SLOW_MS   – requests longer than this many milliseconds are flagged
 *                      with "⚠ SLOW" (default: 200)
 *   TIMING_LOG_ALL   – set to "true" to log every request regardless of speed;
 *                      by default only slow requests are logged so the console
 *                      stays readable in production (default: false in production,
 *                      true in development)
 *
 * The middleware also attaches a `res.locals.startHrTime` value so downstream
 * handlers can compute partial timings if needed.
 */

const NODE_ENV = process.env.NODE_ENV || "development";
const SLOW_MS = parseInt(process.env.TIMING_SLOW_MS || "200", 10);
// In development log every request by default so you see the full picture.
// In production only flag slow ones to avoid log noise.
const LOG_ALL =
  process.env.TIMING_LOG_ALL !== undefined
    ? process.env.TIMING_LOG_ALL === "true"
    : NODE_ENV !== "production";

export function timingMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.locals.startHrTime = start;

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    const isSlow = ms >= SLOW_MS;

    if (!LOG_ALL && !isSlow) return;

    // Keep URLs readable but not unboundedly long.
    const url = (req.originalUrl || req.url).slice(0, 120);
    const status = res.statusCode;
    const flag = isSlow ? "  ⚠ SLOW" : "";
    console.log(
      `[timing] ${req.method.padEnd(6)} ${url.padEnd(70)} → ${status}  ${ms.toFixed(1)}ms${flag}`,
    );
  });

  next();
}

/**
 * Return the milliseconds elapsed since `res.locals.startHrTime` was set by
 * timingMiddleware. Useful for adding sub-step timings inside route handlers.
 *
 * Example:
 *   const elapsed = elapsedMs(res);
 *   console.log(`[timing] SPARQL select took ${elapsed}ms`);
 */
export function elapsedMs(res) {
  if (!res.locals.startHrTime) return 0;
  return Number(process.hrtime.bigint() - res.locals.startHrTime) / 1_000_000;
}
