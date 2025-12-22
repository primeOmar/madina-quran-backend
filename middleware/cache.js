// Simple in-memory cache with TTL
const cache = new Map();

/**
 * Cache middleware factory
 * @param {number} duration - Cache duration in seconds
 * @param {function} keyGenerator - Function to generate cache key from req
 */
export const cacheMiddleware = (duration = 30, keyGenerator = null) => {
  return (req, res, next) => {
    // Generate cache key
    const key = keyGenerator 
      ? keyGenerator(req) 
      : `${req.method}:${req.originalUrl}`;
    
    // Check if cached response exists and is valid
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      console.log(`✅ Cache HIT: ${key}`);
      return res.json(cached.data);
    }
    
    console.log(`❌ Cache MISS: ${key}`);
    
    // Store original res.json
    const originalJson = res.json.bind(res);
    
    // Override res.json to cache the response
    res.json = (body) => {
      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(key, {
          data: body,
          expiresAt: Date.now() + (duration * 1000)
        });
        
        // Clean up expired entries periodically
        if (Math.random() < 0.01) { // 1% chance
          cleanExpiredCache();
        }
      }
      
      return originalJson(body);
    };
    
    next();
  };
};

// Clean expired cache entries
function cleanExpiredCache() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, value] of cache.entries()) {
    if (now >= value.expiresAt) {
      cache.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired cache entries`);
  }
}

// Manual cache clearing
export const clearCache = (pattern = null) => {
  if (!pattern) {
    cache.clear();
    console.log('🗑️ All cache cleared');
  } else {
    let cleared = 0;
    for (const key of cache.keys()) {
      if (key.includes(pattern)) {
        cache.delete(key);
        cleared++;
      }
    }
    console.log(`🗑️ Cleared ${cleared} cache entries matching: ${pattern}`);
  }
};