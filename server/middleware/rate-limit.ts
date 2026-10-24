import type { NextFunction, Request, Response } from 'express';

/** Simple fixed-window, in-memory rate limiter for write endpoints (per client IP). */
export function rateLimit(perMinute: number) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart >= 60_000) {
      hits.set(key, { windowStart: now, count: 1 });
      return next();
    }
    entry.count++;
    if (entry.count > perMinute) {
      res.setHeader('Retry-After', String(Math.ceil((entry.windowStart + 60_000 - now) / 1000)));
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' } });
    }
    next();
  };
}
