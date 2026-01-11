// ============================================
// SERVER.JS - PRODUCTION READY
// ============================================

// Import required dependencies
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';

// Import route handlers
import { standardLimiter } from './middleware/rateLimiter.js';
import adminRoutes from './routes/admin.js';
import teacherRoutes from './routes/teacher.js';
import studentRoutes from './routes/student.js';
import agoraRoutes from './routes/agora.js';
import publicVideoRoutes from './routes/public-video.js';
import videoRoutes from './routes/video.js';

// ============================================
// ENVIRONMENT CONFIGURATION
// ============================================

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'PORT'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars);
  console.error('Please set these in your Render environment variables or .env file');
  process.exit(1);
}

// ============================================
// EXPRESS APP CONFIGURATION
// ============================================

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================
// CORS CONFIGURATION (PRODUCTION READY)
// ============================================

const allowedOrigins = [
  "https://madinaquran.vercel.app", 
  "http://localhost:3000", 
  "http://localhost:3001",
  "https://madina-quran-backend.onrender.com",
  "https://www.madinaquranclasses.com",
  "https://localhost",       
  "http://localhost",        
  "capacitor://localhost"
];

console.log("🔄 Allowed CORS origins:", allowedOrigins);

// CORS middleware configuration
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin) {
      return callback(null, true);
    }
    
    // Remove trailing slash for comparison
    const cleanOrigin = origin.replace(/\/$/, '');
    
    // Check if origin is in allowed list
    const isAllowed = allowedOrigins.some(allowedOrigin => 
      cleanOrigin === allowedOrigin.replace(/\/$/, '')
    );
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`❌ CORS blocked origin: ${cleanOrigin}`);
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400 // 24 hours
};

// Apply CORS middleware - DO NOT use app.options('*', ...)
app.use(cors(corsOptions));

// ============================================
// SECURITY MIDDLEWARE
// ============================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Compression
app.use(compression());

// Request logging
app.use(morgan('combined'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use(standardLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// CACHE UTILITIES
// ============================================

const cache = {
  teachers: { data: null, timestamp: 0 },
  students: { data: null, timestamp: 0 },
  classes: { data: null, timestamp: 0 },
  liveSessions: { data: null, timestamp: 0 },
  profiles: { data: null, timestamp: 0 },
  users: { data: null, timestamp: 0 },
  dynamic: {}
};

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

const clearCache = (keys = null) => {
  if (keys === null) {
    Object.keys(cache).forEach(key => {
      if (key === 'dynamic') {
        cache.dynamic = {};
      } else {
        cache[key] = { data: null, timestamp: 0 };
      }
    });
    console.log('🗑️ All cache cleared');
  } else if (Array.isArray(keys)) {
    keys.forEach(key => {
      if (cache[key]) {
        cache[key] = { data: null, timestamp: 0 };
      } else if (cache.dynamic[key]) {
        delete cache.dynamic[key];
      }
    });
    console.log(`🗑️ Cache cleared for: ${keys.join(', ')}`);
  } else if (typeof keys === 'string') {
    if (cache[keys]) {
      cache[keys] = { data: null, timestamp: 0 };
    } else if (cache.dynamic[keys]) {
      delete cache.dynamic[keys];
    }
  }
};

const isCacheValid = (cacheKey) => {
  if (cache[cacheKey]) {
    const now = Date.now();
    return cache[cacheKey].data && (now - cache[cacheKey].timestamp) < CACHE_DURATION;
  }
  
  if (cache.dynamic[cacheKey]) {
    const now = Date.now();
    return cache.dynamic[cacheKey].data && (now - cache.dynamic[cacheKey].timestamp) < CACHE_DURATION;
  }
  
  return false;
};

const setCache = (key, data) => {
  if (cache[key] !== undefined && key !== 'dynamic') {
    cache[key] = { data, timestamp: Date.now() };
  } else {
    cache.dynamic[key] = { data, timestamp: Date.now() };
  }
};

const getCache = (key) => {
  let cacheEntry;
  
  if (cache[key] !== undefined && key !== 'dynamic') {
    cacheEntry = cache[key];
  } else {
    cacheEntry = cache.dynamic[key];
  }
  
  if (cacheEntry && isCacheValid(key)) {
    return cacheEntry.data;
  }
  
  return null;
};

// Export cache utilities
export { clearCache, getCache, setCache };

// ============================================
// SUPABASE CLIENT CONFIGURATION
// ============================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

// Validate Supabase credentials
if (!supabaseServiceKey.startsWith('eyJ')) {
  console.error('❌ SUPABASE_SERVICE_KEY appears to be invalid. It should start with "eyJ"');
  console.error('Make sure you\'re using the service_role key, not the anon key');
  process.exit(1);
}

console.log('🔧 Initializing Supabase client...');
console.log('URL:', supabaseUrl);
console.log('Service Key configured:', supabaseServiceKey ? '✅ Yes' : '❌ No');

// Create Supabase client
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  },
  global: {
    headers: {
      'x-application-name': 'madina-quran-backend'
    }
  }
});

// Export Supabase client
export { supabase };

// ============================================
// DATABASE CONNECTION TEST
// ============================================

async function testDatabaseConnection() {
  try {
    console.log('🧪 Testing database connection...');
    
    // Simple query to test connection
    const { data, error } = await supabase
      .from('profiles')
      .select('count', { count: 'exact', head: true })
      .limit(1);
    
    if (error) {
      console.error('❌ Database connection test failed:', error.message);
      return false;
    }
    
    console.log('✅ Database connection successful');
    return true;
    
  } catch (error) {
    console.error('❌ Database connection test error:', error.message);
    return false;
  }
}

// ============================================
// ROUTE HANDLERS
// ============================================

// Mount API routes
app.use('/api/student', studentRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/agora', agoraRoutes);
app.use('/api/public-video', publicVideoRoutes);
app.use('/api/video', videoRoutes);

// ============================================
// HEALTH & MONITORING ENDPOINTS
// ============================================

// Health check endpoint
app.get('/api/health', async (req, res) => {
  const dbConnected = await testDatabaseConnection();
  
  const healthStatus = {
    status: dbConnected ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    service: 'madina-quran-backend',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    database: {
      connected: dbConnected,
      url: supabaseUrl ? '✅ Configured' : '❌ Not configured'
    },
    cors: {
      enabled: true,
      allowedOrigins: allowedOrigins.length
    },
    limits: {
      rateLimit: '100 requests per 15 minutes'
    }
  };
  
  const statusCode = dbConnected ? 200 : 503;
  res.status(statusCode).json(healthStatus);
});

// Simple ping endpoint
app.get('/api/ping', (req, res) => {
  res.json({
    message: 'pong',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ============================================
// ERROR HANDLING MIDDLEWARE
// ============================================

// 404 handler - DO NOT use '*'
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', {
    message: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
  
  // Handle CORS errors
  if (error.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'CORS error: Request origin not allowed',
      allowedOrigins
    });
  }
  
  // Handle rate limit errors
  if (error.status === 429) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Too many requests from this IP, please try again later.'
    });
  }
  
  // Generic error response
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' 
      ? 'Something went wrong' 
      : error.message
  });
});

// ============================================
// SERVER STARTUP
// ============================================

async function startServer() {
  try {
    // Test database connection before starting
    console.log('🚀 Starting server...');
    
    const dbConnected = await testDatabaseConnection();
    
    if (!dbConnected) {
      console.error('❌ Cannot start server: Database connection failed');
      process.exit(1);
    }
    
    // Start the server
    app.listen(PORT, () => {
      console.log('='.repeat(50));
      console.log(`✅ Server successfully started!`);
      console.log(`🌐 Port: ${PORT}`);
      console.log(`🔗 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`📊 Database: ${dbConnected ? 'Connected ✅' : 'Disconnected ❌'}`);
      console.log(`🌍 CORS: ${allowedOrigins.length} allowed origins`);
      console.log('='.repeat(50));
      console.log(`🚀 Ready to handle requests at http://localhost:${PORT}`);
      console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🏓 Ping: http://localhost:${PORT}/api/ping`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer();
