// Main server file that sets up the Express application, middleware, Supabase client,
// caching utilities, and mounts Admin, Teacher, and Student routes.

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
import adminRoutes from './routes/admin.js';
import teacherRoutes from './routes/teacher.js';
import studentRoutes from './routes/student.js';
import agoraRoutes from './routes/agora.js';

// Load environment variables from .env file
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Cache configuration for storing frequently accessed data
const cache = {
  // Predefined cache keys
  teachers: { data: null, timestamp: 0 },
  students: { data: null, timestamp: 0 },
  classes: { data: null, timestamp: 0 },
  liveSessions: { data: null, timestamp: 0 },
  profiles: { data: null, timestamp: 0 },
  users: { data: null, timestamp: 0 },
  // Dynamic keys storage
  dynamic: {}
};

// Cache duration set to 5 minutes
const CACHE_DURATION = 5 * 60 * 1000;

// Cache utility functions
// Clears cache for specified keys or all cache if no keys provided
const clearCache = (keys = null) => {
  if (keys === null) {
    // Clear all cache
    Object.keys(cache).forEach(key => {
      if (key === 'dynamic') {
        cache.dynamic = {};
      } else {
        cache[key] = { data: null, timestamp: 0 };
      }
    });
    console.log('🗑️ All cache cleared');
  } else if (Array.isArray(keys)) {
    // Clear specific keys
    keys.forEach(key => {
      if (cache[key]) {
        cache[key] = { data: null, timestamp: 0 };
      } else if (cache.dynamic[key]) {
        delete cache.dynamic[key];
      }
    });
    console.log(`🗑️ Cache cleared for: ${keys.join(', ')}`);
  } else if (typeof keys === 'string') {
    // Clear single key
    if (cache[keys]) {
      cache[keys] = { data: null, timestamp: 0 };
      console.log(`🗑️ Cache cleared for: ${keys}`);
    } else if (cache.dynamic[keys]) {
      delete cache.dynamic[keys];
      console.log(`🗑️ Dynamic cache cleared for: ${keys}`);
    }
  }
};

// Checks if cache for a given key is valid (not expired)
const isCacheValid = (cacheKey) => {
  // Check if it's a predefined key
  if (cache[cacheKey]) {
    const now = Date.now();
    return cache[cacheKey].data && (now - cache[cacheKey].timestamp) < CACHE_DURATION;
  }
  
  // Check if it's a dynamic key
  if (cache.dynamic[cacheKey]) {
    const now = Date.now();
    return cache.dynamic[cacheKey].data && (now - cache.dynamic[cacheKey].timestamp) < CACHE_DURATION;
  }
  
  return false;
};

// Sets cache data for a given key
const setCache = (key, data) => {
  // If it's a predefined key, use the main cache
  if (cache[key] !== undefined && key !== 'dynamic') {
    cache[key] = { data, timestamp: Date.now() };
  } else {
    // Otherwise, use dynamic cache
    cache.dynamic[key] = { data, timestamp: Date.now() };
  }
  console.log(`💾 Cache set for: ${key}`);
};

// Retrieves cached data if valid, otherwise returns null
const getCache = (key) => {
  let cacheEntry;
  
  // Check if it's a predefined key
  if (cache[key] !== undefined && key !== 'dynamic') {
    cacheEntry = cache[key];
  } else {
    // Check dynamic cache
    cacheEntry = cache.dynamic[key];
  }
  
  if (cacheEntry && isCacheValid(key)) {
    console.log(`📦 Cache hit for: ${key}`);
    return cacheEntry.data;
  }
  
  console.log(`❌ Cache miss for: ${key}`);
  return null;
};

// Export cache utilities for use in route files
export { clearCache, getCache, setCache };

// CORS configuration to allow specific origins
// CORRECT CORS configuration
const allowedOrigins = [
  "https://madinaquran.vercel.app", // Your Vercel frontend
  "http://localhost:3000", // Local development
  "https://madina-quran-backend.onrender.com", // Your own backend (for testing)
];

console.log("🔄 Allowed CORS origins:", allowedOrigins);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin) {
      console.log("🔧 No origin header - allowing request");
      return callback(null, true);
    }
    
    // Remove trailing slash from origin for comparison
    const cleanOrigin = origin.replace(/\/$/, '');
    
    if (allowedOrigins.includes(cleanOrigin)) {
      console.log(`✅ CORS allowed for: ${cleanOrigin}`);
      callback(null, true);
    } else {
      console.warn(`❌ CORS blocked: ${cleanOrigin}`);
      console.warn("Allowed origins:", allowedOrigins);
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests for all routes - FIXED: Use a single options handler
app.options(/.*/, (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.status(200).send();
});

// Add detailed request logging for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  console.log('Origin:', req.headers.origin);
  console.log('Authorization:', req.headers.authorization ? 'Present' : 'Missing');
  next();
});

// Apply security and performance middleware
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
app.use(compression());
app.use(morgan('combined'));

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests from this IP, please try again later.' }
});
app.use(limiter);

// Parse JSON bodies with a limit of 10mb
app.use(express.json({ limit: '10mb' }));

// Supabase client configuration
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing required Supabase environment variables:');
  console.error('SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Present' : '❌ Missing');
  console.error('SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? '✅ Present' : '❌ Missing');
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

// Validate the service key format
if (!supabaseServiceKey.startsWith('eyJ')) {
  console.error('❌ SUPABASE_SERVICE_KEY appears to be invalid. It should start with "eyJ"');
  console.error('Make sure you\'re using the service_role key, not the anon key');
  process.exit(1);
}

console.log('🔧 Initializing Supabase client...');
console.log('URL:', supabaseUrl);
console.log('Service Key (first 20 chars):', supabaseServiceKey.substring(0, 20) + '...');

// Create Supabase client with service role key for admin operations
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Export Supabase client for use in route files
export { supabase };

// Test Supabase connection
async function testSupabaseConnection() {
  try {
    console.log('🧪 Testing Supabase connection...');
    const { data, error } = await supabase.from('profiles').select('count', { count: 'exact', head: true });
    if (error) {
      console.error('❌ Supabase connection test failed:', error);
      return false;
    }
    console.log('✅ Supabase connection successful');
    return true;
  } catch (err) {
    console.error('❌ Supabase connection test error:', err);
    return false;
  }
}

// Test Supabase admin API access
async function testSupabaseAdminAccess() {
  try {
    console.log('🔑 Testing Supabase Admin API access...');
    const { data, error } = await supabase.auth.admin.listUsers({ 
      page: 1, 
      perPage: 1 
    });
    
    if (error) {
      console.error('❌ Admin API test failed:', error);
      console.error('Error code:', error.code);
      console.error('Error status:', error.status);
      return false;
    }
    
    console.log('✅ Admin API access successful');
    console.log('Total users found:', data.users.length);
    return true;
  } catch (err) {
    console.error('❌ Admin API test error:', err.message);
    console.error('Error code:', err.code);
    return false;
  }
}

// Test both connections on startup
testSupabaseConnection();
testSupabaseAdminAccess();

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Mount route handlers with proper base paths
app.use('/api/student', studentRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/agora', agoraRoutes);
// General utility endpoint for generating Agora token
app.post('/api/generate-agora-token', async (req, res) => {
  try {
    const { channelName, userId, role = 'publisher' } = req.body;
    
    if (!channelName || !userId) {
      return res.status(400).json({ error: 'Channel name and user ID are required' });
    }

    // Placeholder for Agora token generation (to be implemented)
    res.json({ 
      token: 'temporary_token_placeholder', 
      channelName,
      appId: process.env.AGORA_APP_ID || 'your_agora_app_id',
      uid: userId,
      role,
      expiration: Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
    });
  } catch (error) {
    console.error('Error generating token:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    cors: allowedOrigins,
    supabase: {
      url: supabaseUrl,
      serviceKeyPresent: !!supabaseServiceKey
    }
  });
});

// Test endpoint for API verification
app.get('/api/test', (req, res) => {
  console.log('✅ Test endpoint hit');
  res.json({ message: 'API is working!', timestamp: new Date().toISOString() });
});

// Error handling middleware for JSON responses
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  
  // Handle CORS errors specifically
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS error: Request not allowed' });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// Handle undefined routes with JSON response
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Admin server running on port ${PORT}`);
  console.log(`🌐 CORS enabled for origins: ${allowedOrigins.join(', ')}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Final connection test
  setTimeout(async () => {
    const isConnected = await testSupabaseConnection();
    if (isConnected) {
      console.log('✅ Server is ready and Supabase is connected!');
    } else {
      console.log('❌ Server started but Supabase connection failed');
    }
  }, 1000);
});
