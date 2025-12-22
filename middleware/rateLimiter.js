import rateLimit from 'express-rate-limit';

// Standard limiter - 100 requests per 15 minutes
export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const resetTime = new Date(req.rateLimit.resetTime);
    res.status(429).json({
      error: 'Too many requests from this IP, please try again later.',
      retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
      limit: req.rateLimit.limit,
      resetTime: resetTime.toISOString()
    });
  }
});

// Strict limiter - 30 requests per minute (for frequent polling endpoints)
export const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const resetTime = new Date(req.rateLimit.resetTime);
    res.status(429).json({
      error: 'Rate limit exceeded. Please wait before retrying.',
      retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
      limit: req.rateLimit.limit,
      resetTime: resetTime.toISOString()
    });
  }
});

// Very strict limiter - 10 requests per minute (for session creation)
export const veryStrictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const resetTime = new Date(req.rateLimit.resetTime);
    res.status(429).json({
      error: 'Too many session requests. Please wait before creating another session.',
      retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
      resetTime: resetTime.toISOString()
    });
  }
});