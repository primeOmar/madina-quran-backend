import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
const router = express.Router();

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Update your cache configuration to support dynamic keys
const cache = {
  // Your existing fixed keys
  teachers: { data: null, timestamp: 0 },
  students: { data: null, timestamp: 0 },
  classes: { data: null, timestamp: 0 },
  liveSessions: { data: null, timestamp: 0 },
  profiles: { data: null, timestamp: 0 },
  users: { data: null, timestamp: 0 },
  
  // Dynamic keys storage
  dynamic: {}
};

const CACHE_DURATION = 5 * 60 * 1000;

// Updated cache functions to handle dynamic keys
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

// Enhanced CORS configuration - FIXED
const allowedOrigins = [
  process.env.FRONTEND_URL?.replace(/\/$/, '') || "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://localhost:5173",  // Add Vite default port
  "http://127.0.0.1:5173",  // Add Vite alternative
  "http://localhost:5174",  // Vite sometimes uses this
  "http://127.0.0.1:5174"   // Vite sometimes uses this
];

console.log("Allowed CORS origins:", allowedOrigins);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin) return callback(null, true);
    
    // Remove trailing slash from origin for comparison
    const cleanOrigin = origin.replace(/\/$/, '');
    
    if (allowedOrigins.includes(cleanOrigin)) {
      callback(null, true);
    } else {
      console.warn("Blocked by CORS:", origin, "Allowed:", allowedOrigins);
      // For development, allow all origins - change this in production
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

// Apply CORS middleware first
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

// Security and performance middleware
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

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));

//Enhanced Supabase client configuration

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

// Test connection on startup
testSupabaseConnection();



//  Admin middleware error handling
const requireAdmin = async (req, res, next) => {
  try {
    const { authorization } = req.headers;
    if (!authorization) {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    const token = authorization.replace('Bearer ', '');
    console.log('🔐 Verifying admin token...');
    
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error('❌ Auth error:', error);
      return res.status(401).json({ error: 'Invalid token' });
    }

    console.log('✅ User authenticated:', user.email);

    // Check if user is admin
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role, status')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('❌ Profile error:', profileError);
      return res.status(403).json({ error: 'Access denied - profile not found' });
    }

    if (profile.role !== 'admin') {
      console.error('❌ Access denied - not admin:', profile.role);
      return res.status(403).json({ error: 'Admin privileges required' });
    }

    if (profile.status !== 'active') {
      console.error('❌ Access denied - inactive account');
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    console.log('✅ Admin access granted');
    req.user = user;
    next();
  } catch (error) {
    console.error('❌ Admin middleware error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

//auth middleware
const requireAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      console.log('❌ No token provided');
      return res.status(401).json({ error: 'Authentication required' });
    }

    console.log('🔐 Verifying token...');

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      console.error('❌ Token verification failed:', authError);
      return res.status(401).json({ error: 'Invalid token' });
    }

    console.log('✅ User authenticated:', user.email);

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, name, email, role, status')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.error('❌ Profile not found:', profileError);
      return res.status(404).json({ error: 'User profile not found' });
    }

    if (profile.status !== 'active') {
      console.log('❌ User account is not active:', profile.status);
      return res.status(403).json({ error: 'Account is not active' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      ...profile
    };

    console.log(`✅ User role: ${profile.role}, Status: ${profile.status}`);
    next();

  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};


//  Admin registration endpoint with  error handling
app.post('/api/admin/register', async (req, res) => {
  try {
    console.log('📝 Admin registration attempt...');
    const { name, email, password, sendConfirmationEmail = true } = req.body;

    if (!name || !email || !password) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ error: 'Missing required fields: name, email, password' });
    }

    console.log('📧 Checking for existing admin:', email);

    // Check if user already exists
    const { data: existingUser, error: checkError } = await supabase
      .from('profiles')
      .select('id, email, role')
      .eq('email', email)
      .maybeSingle();

    if (checkError) {
      console.error('❌ Error checking existing admin:', checkError);
      return res.status(500).json({ error: 'Database error while checking existing admin' });
    }

    if (existingUser) {
      console.error('❌ User already exists:', email);
      return res.status(400).json({ error: 'A user with this email already exists' });
    }

    console.log('🔑 Creating auth user...');

    // Add detailed logging before the createUser call
    console.log('📊 CreateUser parameters:', {
      email,
      hasPassword: !!password,
      passwordLength: password?.length,
      email_confirm: !sendConfirmationEmail, // Inverse logic: false = send email, true = skip email
      user_metadata: { name, role: 'admin' }
    });

    // Create auth user - with email confirmation based on sendConfirmationEmail flag
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: !sendConfirmationEmail, // Set to false to trigger confirmation email
      user_metadata: { 
        name, 
        role: 'admin',
        created_by: 'admin_registration'
      }
    });

    if (authError) {
      console.error('❌ Auth create error details:', {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        details: authError.details,
        __isAuthError: authError.__isAuthError
      });
      console.error('❌ Full error object:', JSON.stringify(authError, null, 2));
      
      // Provide more specific error messages
      let errorMessage = authError.message;
      if (authError.message?.includes('Email')) {
        errorMessage = 'Email configuration issue. Please check SMTP settings.';
      }
      
      return res.status(400).json({ error: errorMessage });
    }

    console.log('✅ Auth user created:', authData.user.id);
    
    // If confirmation email was requested, log the status
    if (sendConfirmationEmail) {
      console.log('📧 Confirmation email should be sent to:', email);
      console.log('📧 User email_confirmed_at:', authData.user.email_confirmed_at);
    }

    console.log('👤 Creating/updating profile...');

    // Check if profile already exists (in case of auto-creation by triggers)
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', authData.user.id)
      .maybeSingle();

    let profileData;

    if (existingProfile) {
      console.log('📝 Profile already exists, updating it...');
      // Update existing profile
      const { data, error: profileError } = await supabase
        .from('profiles')
        .update({
          email,
          name,
          role: 'admin',
          status: sendConfirmationEmail ? 'pending_confirmation' : 'active',
          updated_at: new Date().toISOString()
        })
        .eq('id', authData.user.id)
        .select()
        .single();
        
      if (profileError) {
        console.error('❌ Profile update error:', profileError);
        // Rollback user creation if profile update fails
        await supabase.auth.admin.deleteUser(authData.user.id);
        return res.status(400).json({ error: 'Failed to update profile: ' + profileError.message });
      }
      
      profileData = data;
    } else {
      console.log('📝 Creating new profile...');
      // Create new profile
      const { data, error: profileError } = await supabase
        .from('profiles')
        .insert([
          {
            id: authData.user.id,
            email,
            name,
            role: 'admin',
            status: sendConfirmationEmail ? 'pending_confirmation' : 'active',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ])
        .select()
        .single();

      if (profileError) {
        console.error('❌ Profile create error:', profileError);
        // Rollback user creation if profile creation fails
        await supabase.auth.admin.deleteUser(authData.user.id);
        return res.status(400).json({ error: 'Failed to create profile: ' + profileError.message });
      }
      
      profileData = data;
    }

    console.log('✅ Profile handled:', profileData);

    // Optional: Send custom welcome email for admins
    if (sendConfirmationEmail) {
      try {
        await sendAdminWelcomeEmail(email, name);
        console.log('📧 Custom admin welcome email sent');
      } catch (emailError) {
        console.error('⚠️ Failed to send welcome email:', emailError);
        // Don't fail the entire registration for email issues
      }
    }

    console.log('🎉 Admin created successfully');

    res.status(201).json({
      message: sendConfirmationEmail 
        ? 'Admin created successfully. Confirmation email sent.' 
        : 'Admin created successfully and activated.',
      admin: {
        id: authData.user.id,
        email,
        name,
        role: 'admin',
        status: profileData.status,
        emailConfirmationSent: sendConfirmationEmail,
        needsEmailConfirmation: sendConfirmationEmail && !authData.user.email_confirmed_at
      }
    });
  } catch (error) {
    console.error('❌ Error creating admin:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Optional: Additional endpoint to manually activate an admin if needed
app.post('/api/admin/activate', async (req, res) => {
  try {
    const { adminId } = req.body;
    
    if (!adminId) {
      return res.status(400).json({ error: 'Admin ID is required' });
    }

    // Update profile status to active
    const { data, error: updateError } = await supabase
      .from('profiles')
      .update({
        status: 'active',
        updated_at: new Date().toISOString()
      })
      .eq('id', adminId)
      .eq('role', 'admin')
      .select()
      .single();

    if (updateError) {
      console.error('❌ Error activating admin:', updateError);
      return res.status(400).json({ error: 'Failed to activate admin' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    console.log('✅ Admin activated:', data.email);
    res.json({ 
      message: 'Admin activated successfully',
      admin: data 
    });
  } catch (error) {
    console.error('❌ Error activating admin:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// FIXED: Admin login endpoint
app.post('/api/admin/login', async (req, res) => {
  try {
    console.log('🔐 Admin login attempt...');
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    console.log('📧 Authenticating:', email);

    // Authenticate with Supabase
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (authError) {
      console.error('❌ Auth login error:', authError);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    console.log('✅ Authentication successful');
    console.log('👤 Verifying admin role...');

    // Verify the user is an admin
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role, status, name')
      .eq('id', authData.user.id)
      .single();

    if (profileError) {
      console.error('❌ Profile fetch error:', profileError);
      await supabase.auth.signOut();
      return res.status(500).json({ error: 'Error verifying user role' });
    }

    if (profile.role !== 'admin') {
      console.error('❌ Access denied - not admin:', profile.role);
      await supabase.auth.signOut();
      return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }

    if (profile.status !== 'active') {
      console.error('❌ Account deactivated');
      await supabase.auth.signOut();
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    console.log('🎉 Admin login successful');

    // Return session data
    res.json({
      message: 'Login successful',
      user: {
        id: authData.user.id,
        email: authData.user.email,
        name: profile.name,
        role: profile.role
      },
      session: authData.session
    });
  } catch (error) {
    console.error('❌ Error during admin login:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Admin logout endpoint
app.post('/api/admin/logout', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.auth.signOut();
    
    if (error) {
      console.error('❌ Logout error:', error);
      return res.status(400).json({ error: 'Logout failed' });
    }

    console.log('✅ Admin logout successful');
    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('❌ Error during logout:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Add student with teacher assignment

// Get students by teacher
app.get('/api/admin/students/teacher/:teacherId', requireAdmin, async (req, res) => {
  try {
    const { teacherId } = req.params;

    const { data, error } = await supabase
      .from('profile')
      .select('*')
      .eq('role', 'student')
      .eq('teacher_id', teacherId)
      .order('name');

    if (error) {
      console.error('❌ Error fetching students by teacher:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Error fetching students by teacher:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current admin profile
app.get('/api/admin/profile', requireAdmin, async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) {
      console.error('❌ Profile fetch error:', error);
      return res.status(400).json({ error: 'Error fetching profile' });
    }

    res.json(profile);
  } catch (error) {
    console.error('❌ Error fetching admin profile:', error);
    res.status(500).json({ error: 'Internal server error' });
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
    },
    email: {
      provider: 'resend',
      configured: !!resend
    }
  });
});

// Add teacher
//Password generation utility
// Secure password generator
const generateSecurePassword = (length = 12) => {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const symbols = '!@#$%^&*()_+-=';
  
  const allChars = uppercase + lowercase + numbers + symbols;
  let password = '';
  
  // Ensure at least one of each character type
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += symbols[Math.floor(Math.random() * symbols.length)];
  
  // Fill the rest
  for (let i = 4; i < length; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }
  
  // Shuffle the password
  return password.split('').sort(() => Math.random() - 0.5).join('');
};

// Input sanitization function
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input.trim().replace(/[<>]/g, '');
};

// Teacher creation endpoint
app.post('/api/admin/teachers', requireAdmin, async (req, res) => {
  let createdUserId = null;
  const clientIp = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('User-Agent');

  try {
    console.log('👨‍🏫 Creating new teacher...', { body: req.body, adminId: req.user.id });

    const { name, email, subject } = req.body;
    if (!name || !email || !subject) {
      return res.status(400).json({ success: false, error: 'Missing required fields: name, email, subject' });
    }

    const sanitizedName = sanitizeInput(name);
    const sanitizedEmail = sanitizeInput(email).toLowerCase();
    const sanitizedSubject = sanitizeInput(subject);

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(sanitizedEmail)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    // Check existing users
    const { data: { users }, error: authCheckError } = await supabase.auth.admin.listUsers();
    if (authCheckError) {
      console.error('Auth check error:', authCheckError);
      return res.status(500).json({ success: false, error: 'Failed to check existing users' });
    }

    if (users.find(user => user.email === sanitizedEmail)) {
      return res.status(400).json({ success: false, error: `User with email ${sanitizedEmail} already exists` });
    }

    // Check profiles
    const { data: existingProfile } = await supabase.from('profiles').select('email').eq('email', sanitizedEmail).maybeSingle();
    if (existingProfile) {
      return res.status(400).json({ success: false, error: `User with email ${sanitizedEmail} already exists in profiles` });
    }

    const password = generateSecurePassword(12);

    // Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: sanitizedEmail,
      password,
      email_confirm: true,
      user_metadata: {
        name: sanitizedName,
        role: 'teacher',
        subject: sanitizedSubject,
        created_by: req.user.id
      }
    });

    if (authError) {
      console.error('Auth creation error:', { message: authError.message, details: authError.details || 'No details', hint: authError.hint || 'No hint' });
      return res.status(400).json({ success: false, error: `Auth creation failed: ${authError.message}` });
    }

    createdUserId = authData.user.id;

    // Create profile (use upsert to handle rare races)
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: createdUserId,
      email: sanitizedEmail,
      name: sanitizedName,
      role: 'teacher',
      subject: sanitizedSubject,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

    if (profileError) {
      console.error('Profile creation error:', profileError);
      if (profileError.code === '23505') {
        return res.status(400).json({ success: false, error: `User with email ${sanitizedEmail} already exists in database` });
      }
      throw new Error(`Profile creation failed: ${profileError.message}`);
    }

    // Log action (use try-catch to not block response)
    await supabase.from('admin_actions').insert({
      admin_id: req.user.id,
      action_type: 'create_teacher',
      target_type: 'profile',
      target_id: createdUserId,
      details: { teacher_email: sanitizedEmail, teacher_name: sanitizedName, subject: sanitizedSubject },
      performed_at: new Date().toISOString(),
      ip_address: clientIp,
      user_agent: userAgent
    }).then(() => console.log('Action logged')).catch(err => console.warn('Failed to log action:', err));

    return res.status(201).json({
      success: true,
      message: 'Teacher created successfully',
      teacher: {
        id: createdUserId,
        email: sanitizedEmail,
        name: sanitizedName,
        subject: sanitizedSubject,
        status: 'active'
      },
      credentials: {
        email: sanitizedEmail,
        password,
        login_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/teacher-login`
      }
    });

  } catch (error) {
    console.error('Teacher creation error:', error, { clientIp, userAgent });
    if (createdUserId) {
      await supabase.auth.admin.deleteUser(createdUserId).catch(deleteErr => console.error('Cleanup failed:', deleteErr));
    }
    return res.status(500).json({ success: false, error: 'Internal server error. Please try again.' });
  }
});
// Additional endpoint to regenerate teacher password
app.post('/api/admin/teachers/:teacherId/reset-password', requireAdmin, async (req, res) => {
  try {
    const { teacherId } = req.params;
    
    if (!teacherId) {
      return res.status(400).json({ error: 'Teacher ID is required' });
    }

    // Verify teacher exists
    const { data: teacher, error: teacherError } = await supabase
      .from('profiles')
      .select('id, email, name, role')
      .eq('id', teacherId)
      .eq('role', 'teacher')
      .single();

    if (teacherError || !teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Generate new password
    const newPassword = generateRandomPassword(12);

    // Update auth user password
    const { error: updateError } = await supabase.auth.admin.updateUserById(teacherId, {
      password: newPassword
    });

    if (updateError) {
      console.error('❌ Password update error:', updateError);
      return res.status(400).json({ error: 'Failed to update password' });
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'reset_teacher_password',
            target_type: 'profile',
            target_id: teacherId,
            details: { teacher_email: teacher.email },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️ Failed to log password reset action:', logError);
    }

    res.json({
      success: true,
      message: 'Teacher password reset successfully',
      teacher: {
        id: teacher.id,
        email: teacher.email,
        name: teacher.name
      },
      credentials: {
        email: teacher.email,
        password: newPassword,
        login_url: `${process.env.APP_URL || 'http://localhost:3000'}/teacher/login`
      }
    });

  } catch (error) {
    console.error('❌ Error resetting teacher password:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove teacher
app.delete('/api/admin/teachers/:id', requireAdmin, async (req, res) => {
  try {
    const teacherId = req.params.id;

    // First check if teacher exists
    const { data: teacher, error: fetchError } = await supabase
      .from('profiles')
      .select('id, name, email')
      .eq('id', teacherId)
      .eq('role', 'teacher')
      .maybeSingle(); // Use maybeSingle()

    if (fetchError) {
      console.error('❌ Fetch teacher error:', fetchError);
      return res.status(400).json({ error: 'Error fetching teacher' });
    }

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Check if teacher has active classes
    const { data: activeClasses, error: classesError } = await supabase
      .from('classes')
      .select('id')
      .eq('teacher_id', teacherId)
      .eq('status', 'active')
      .limit(1);

    if (classesError) {
      console.error('❌ Error checking active classes:', classesError);
      return res.status(400).json({ error: 'Error checking teacher classes' });
    }

    if (activeClasses && activeClasses.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot remove teacher with active classes. Please reassign classes first.' 
      });
    }

    // Delete the teacher
    const { error: deleteError } = await supabase.auth.admin.deleteUser(teacherId);

    if (deleteError) {
      console.error('❌ Delete teacher error:', deleteError);
      return res.status(400).json({ error: deleteError.message });
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'remove_teacher',
            target_type: 'profile',
            target_id: teacherId,
            details: { name: teacher.name, email: teacher.email },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('teachers');

    res.json({ message: 'Teacher removed successfully' });
  } catch (error) {
    console.error('❌ Error removing teacher:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test email endpoint with Resend
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    if (!resend) {
      return res.status(400).json({ 
        error: 'Resend not configured. Check RESEND_API_KEY environment variable.' 
      });
    }

    const { to, subject = 'Test Email from Madrasa', message = 'This is a test email' } = req.body;
    const recipient = to || process.env.TEST_EMAIL || req.user.email;

    const { data: emailData, error: emailError } = await resend.emails.send({
      from: process.env.FROM_EMAIL || 'Madrasa <test@madrasa.edu>',
      to: [recipient],
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Test Email from Madrasa Admin Dashboard</h2>
          <p style="font-size: 16px; line-height: 1.6; color: #555;">${message}</p>
          <div style="background: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; color: #0066cc;"><strong>✅ Email system is working correctly!</strong></p>
          </div>
          <p style="font-size: 14px; color: #888;">
            This test email was sent at ${new Date().toISOString()}
          </p>
        </div>
      `
    });
    
    if (emailError) {
      console.error('❌ Test email failed:', emailError);
      return res.status(500).json({ 
        error: 'Email test failed: ' + emailError.message 
      });
    }

    console.log('✅ Test email sent successfully:', emailData.id);
    
    res.json({ 
      success: true, 
      message: 'Test email sent successfully',
      emailId: emailData.id,
      sentTo: recipient
    });
    
  } catch (error) {
    console.error('❌ Test email error:', error.message);
    res.status(500).json({ 
      error: 'Email test failed: ' + error.message
    });
  }
});

// Add student with teacher assignment
app.post('/api/admin/students', requireAdmin, async (req, res) => {
  try {
    const { name, email, course, teacher_id } = req.body;

    if (!name || !email || !course || !teacher_id) {
      return res.status(400).json({ error: 'Missing required fields: name, email, course, teacher_id' });
    }

    // Check if student already exists
    const { data: existingStudent, error: checkError } = await supabase
      .from('students')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (checkError) {
      console.error('❌ Error checking existing student:', checkError);
      return res.status(400).json({ error: 'Error checking existing user' });
    }

    if (existingStudent) {
      return res.status(400).json({ error: 'A student with this email already exists' });
    }

    // Check if teacher exists
    const { data: teacher, error: teacherError } = await supabase
      .from('profiles')
      .select('id, name')
      .eq('id', teacher_id)
      .eq('role', 'teacher')
      .maybeSingle();

    if (teacherError) {
      console.error('❌ Error checking teacher:', teacherError);
      return res.status(400).json({ error: 'Error checking teacher' });
    }

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Generate random password
    const password = generateRandomPassword();

    // Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name, role: 'student' }
    });

    if (authError) {
      console.error('❌ Auth create error:', authError);
      return res.status(400).json({ error: authError.message });
    }

    // Create profile with student  and teacher assignment
    const { error: profileError } = await supabase
      .from('profiles')
      .insert([
        {
          id: authData.user.id,
          email,
          name,
          role: 'student',
          course,
          teacher_id, // Assign student to specific teacher
          status: 'active',
          created_at: new Date().toISOString()
        }
      ]);

    if (profileError) {
      // Rollback user creation if profile creation fails
      await supabase.auth.admin.deleteUser(authData.user.id);
      console.error('❌ Profile create error:', profileError);
      return res.status(400).json({ error: profileError.message });
    }

    // Create student-teacher relationship
    const { error: relationshipError } = await supabase
      .from('student_teachers')
      .insert([
        {
          student_id: authData.user.id,
          teacher_id: teacher_id,
          assigned_by: req.user.id,
          assigned_at: new Date().toISOString()
        }
      ]);

    if (relationshipError) {
      console.error('❌ Error creating student-teacher relationship:', relationshipError);
      // Continue anyway - the student was created successfully
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'create_student',
            target_type: 'profile',
            target_id: authData.user.id,
            details: { email, name, course, teacher_id, teacher_name: teacher.name },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('students');

    res.status(201).json({
      message: 'Student created successfully and assigned to teacher',
      student: {
        id: authData.user.id,
        email,
        name,
        course,
        teacher_id,
        teacher_name: teacher.name,
        status: 'active'
      }
    });
  } catch (error) {
    console.error('❌ Error creating student:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reassign student to different teacher
app.patch('/api/admin/students/:id/reassign', requireAdmin, async (req, res) => {
  try {
    const studentId = req.params.id;
    const { teacher_id } = req.body;

    if (!teacher_id) {
      return res.status(400).json({ error: 'Teacher ID is required' });
    }

    // Check if student exists
    const { data: student, error: studentError } = await supabase
      .from('profiles')
      .select('id, name')
      .eq('id', studentId)
      .eq('role', 'student')
      .maybeSingle();

    if (studentError) {
      console.error('❌ Error fetching student:', studentError);
      return res.status(400).json({ error: 'Error fetching student' });
    }

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Check if new teacher exists
    const { data: teacher, error: teacherError } = await supabase
      .from('profiles')
      .select('id, name')
      .eq('id', teacher_id)
      .eq('role', 'teacher')
      .maybeSingle();

    if (teacherError) {
      console.error('❌ Error fetching teacher:', teacherError);
      return res.status(400).json({ error: 'Error fetching teacher' });
    }

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Update student's teacher assignment
    const { data, error: updateError } = await supabase
      .from('profiles')
      .update({ 
        teacher_id,
        updated_at: new Date().toISOString()
      })
      .eq('id', studentId)
      .select();

    if (updateError) {
      console.error('❌ Error updating student teacher:', updateError);
      return res.status(400).json({ error: updateError.message });
    }

    // Update student-teacher relationship
    const { error: relationshipError } = await supabase
      .from('student_teachers')
      .upsert([
        {
          student_id: studentId,
          teacher_id: teacher_id,
          assigned_by: req.user.id,
          assigned_at: new Date().toISOString()
        }
      ]);

    if (relationshipError) {
      console.error('❌ Error updating student-teacher relationship:', relationshipError);
      // Continue anyway - the main update was successful
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'reassign_student',
            target_type: 'profile',
            target_id: studentId,
            details: { 
              student_name: student.name, 
              new_teacher_id: teacher_id, 
              new_teacher_name: teacher.name 
            },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('students');

    res.json({ 
      message: 'Student reassigned successfully',
      student: data[0],
      new_teacher: teacher.name
    });
  } catch (error) {
    console.error('❌ Error reassigning student:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove student
app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
  try {
    const studentId = req.params.id;

    // First check if student exists
    const { data: student, error: fetchError } = await supabase
      .from('profiles')
      .select('id, name, email')
      .eq('id', studentId)
      .eq('role', 'student')
      .maybeSingle();

    if (fetchError) {
      console.error('❌ Fetch student error:', fetchError);
      return res.status(400).json({ error: 'Error fetching student' });
    }

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // First remove student-teacher relationships
    const { error: relationshipError } = await supabase
      .from('student_teachers')
      .delete()
      .eq('student_id', studentId);

    if (relationshipError) {
      console.error('❌ Error removing student relationships:', relationshipError);
      // Continue with deletion anyway
    }

    // Delete the student
    const { error: deleteError } = await supabase.auth.admin.deleteUser(studentId);

    if (deleteError) {
      console.error('❌ Delete student error:', deleteError);
      return res.status(400).json({ error: deleteError.message });
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'remove_student',
            target_type: 'profile',
            target_id: studentId,
            details: { name: student.name, email: student.email },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('students');

    res.json({ message: 'Student removed successfully' });
  } catch (error) {
    console.error('❌ Error removing student:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Get all teachers with caching
app.get('/api/admin/teachers', requireAdmin, async (req, res) => {
  try {
    console.log('📚 Fetching teachers...');
    
    // Check cache first
    const cachedData = getCache('teachers');
    if (cachedData) {
      return res.json(cachedData); // Return data directly, not wrapped
    }

    console.log('❌ Cache miss for: teachers - fetching from database');

    // Fetch from database
    const { data, error } = await supabase
      .from('profiles')
      .select(`
        id,
        name,
        email,
        subject,
        role,
        status,
        created_at,
        updated_at
      `)
      .eq('role', 'teacher')
      .order('name');

    if (error) {
      console.error('❌ Error fetching teachers:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Fetched ${data?.length || 0} teachers from database`);

    // Update cache
    setCache('teachers', data || []);

    // Return data directly (compatible with existing frontend)
    res.json(data || []);

  } catch (error) {
    console.error('❌ Error fetching teachers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all students with caching
app.get('/api/admin/students', requireAdmin, async (req, res) => {
  try {
    console.log('👥 Fetching students from profiles table...');
    
    // Check cache first
    const cachedData = getCache('students');
    if (cachedData) {
      console.log('📦 Cache hit for: students');
      return res.json(cachedData);
    }

    console.log('❌ Cache miss for: students - fetching from profiles table');

    // CORRECTED: Changed from 'profile' to 'profiles'
    const { data, error } = await supabase
      .from('profiles')  // ← Changed to plural 'profiles'
      .select(`
        id,
        name,
        email,
        course,
        teacher_id,
        created_at,
        updated_at,
        role,
        status,
        subject,
        teacher:teacher_id ( 
          id,
          name,
          email,
          subject,
          status,
          role
        )
      `)
      .eq('role', 'student')  // ← Added filter to only get students
      .order('name', { ascending: true });

    if (error) {
      console.error('❌ Error fetching students from profiles:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Fetched ${data?.length || 0} students from profiles table`);

    // Transform data to include teacher information
    const studentsWithTeacherInfo = data.map(student => ({
      id: student.id,
      email: student.email,
      name: student.name,
      course: student.course,
      subject: student.subject,
      status: student.status,
      role: student.role,
      created_at: student.created_at,
      updated_at: student.updated_at,
      teacher_id: student.teacher_id,
      teacher_name: student.teacher?.name || null,
      teacher_email: student.teacher?.email || null,
      teacher_subject: student.teacher?.subject || null,
      teacher_status: student.teacher?.status || null
    }));

    // Update cache
    setCache('students', studentsWithTeacherInfo || []);

    // Return transformed data
    res.json(studentsWithTeacherInfo || []);

  } catch (error) {
    console.error('❌ Error fetching students:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Get all classes with caching

app.get('/classes', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('classes')
      .select(`
        id,
        title,
        teacher_id,
        course_id,
        status,
        scheduled_date,
        duration,
        end_date,
        created_at,
        profiles (
          id,
          name,
          email
        ),
        courses (
          id,
          name
        )
      `)
      .order('scheduled_date', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});


//schedule classes endpoints
app.post('/classes', requireAdmin, async (req, res) => {
  try {
    const { title, teacher_id, scheduled_date, duration, max_students, description, recurring } = req.body;
    
    // Validate input
    if (!title || !teacher_id || !scheduled_date) {
      return res.status(400).json({ error: 'Title, teacher ID, and scheduled date are required' });
    }

    // Check if teacher exists and is actually a teacher
    const { data: teacher, error: teacherError } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', teacher_id)
      .eq('role', 'teacher')
      .single();

    if (teacherError || !teacher) {
      return res.status(400).json({ error: 'Invalid teacher ID or teacher not found' });
    }

    // Handle recurring classes
    let classesToCreate = [{
      title,
      teacher_id,
      scheduled_date: new Date(scheduled_date).toISOString(),
      duration: duration || 60,
      max_students: max_students || 20,
      description,
      status: 'scheduled'
    }];

    if (recurring && recurring.frequency) {
      // Generate recurring classes (weekly for a month)
      for (let i = 1; i <= 3; i++) {
        const nextDate = new Date(scheduled_date);
        nextDate.setDate(nextDate.getDate() + (7 * i));
        
        classesToCreate.push({
          title,
          teacher_id,
          scheduled_date: nextDate.toISOString(),
          duration: duration || 60,
          max_students: max_students || 20,
          description,
          status: 'scheduled'
        });
      }
    }

    // Insert classes
    const { data: classes, error } = await supabase
      .from('classes')
      .insert(classesToCreate)
      .select(`
        *,
        teacher:teacher_id (id, name, email)
      `);

    if (error) {
      console.error('Error creating classes:', error);
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(classes);
  } catch (error) {
    console.error('Error scheduling class:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all classes with filtering
app.get('/classes', requireAdmin, async (req, res) => {
  try {
    const { teacher_id, status, start_date, end_date, page = 1, limit = 50 } = req.query;
    
    let query = supabase
      .from('classes')
      .select(`
        *,
        teacher:teacher_id (id, name, email),
        video_sessions (id, meeting_id, status, started_at),
        students_classes (student_id)
      `, { count: 'exact' });

    // Apply filters
    if (teacher_id) query = query.eq('teacher_id', teacher_id);
    if (status) query = query.eq('status', status);
    if (start_date) query = query.gte('scheduled_date', start_date);
    if (end_date) query = query.lte('scheduled_date', end_date);

    // Pagination
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    
    query = query.order('scheduled_date', { ascending: true })
                 .range(from, to);

    const { data: classes, error, count } = await query;

    if (error) {
      console.error('Error fetching classes:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({
      classes,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count
      }
    });
  } catch (error) {
    console.error('Error fetching classes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update class
app.put('/classes/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: classData, error } = await supabase
      .from('classes')
      .update(updates)
      .eq('id', id)
      .select(`
        *,
        teacher:teacher_id (id, name, email)
      `)
      .single();

    if (error) {
      console.error('Error updating class:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json(classData);
  } catch (error) {
    console.error('Error updating class:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete class
app.delete('/classes/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('classes')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting class:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Error deleting class:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get live sessions with caching
app.get('/api/admin/video-sessions', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('video_sessions')
      .select(`
        id,
        meeting_id,
        class_id,
        teacher_id,
        status,
        started_at,
        created_at,
        channel_name,
        agenda,
        profiles (
          name,
          email
        ),
        classes (
          title
        )
      `)
      .order('started_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // If you need renaming of fields:
    const sessions = (data || []).map(session => ({
      ...session,
      start_time: session.started_at,
      description: session.agenda,
      title: session.classes?.title,
      teacher_name: session.profiles?.name,
      teacher_email: session.profiles?.email,
    }));

    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Join video call as admin
app.post('/api/admin/join-video-call', requireAdmin, async (req, res) => {
  try {
    const { meetingId } = req.body;

    if (!meetingId) {
      return res.status(400).json({ error: 'Meeting ID is required' });
    }

    // Check if meeting exists
    const { data: meeting, error: meetingError } = await supabase
      .from('video_sessions')
      .select('*')
      .eq('meeting_id', meetingId)
      .maybeSingle(); // Use maybeSingle()

    if (meetingError) {
      console.error('❌ Error fetching meeting:', meetingError);
      return res.status(400).json({ error: 'Error fetching meeting' });
    }

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // In a real implementation, this would generate a token for your video provider (Agora, Twilio, etc.)
    const adminToken = `admin-${meetingId}-${Date.now()}`;

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'join_video_call',
            target_type: 'video_session',
            target_id: meeting.id,
            details: { meetingId, adminToken },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('liveSessions');

    res.json({
      meetingId,
      adminToken,
      message: 'Admin joined video call successfully'
    });
  } catch (error) {
    console.error('❌ Error joining video call:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove participant from video call
app.post('/api/admin/remove-from-video-call', requireAdmin, async (req, res) => {
  try {
    const { meetingId, participantId } = req.body;

    if (!meetingId || !participantId) {
      return res.status(400).json({ error: 'Meeting ID and Participant ID are required' });
    }

    // Check if meeting exists
    const { data: meeting, error: meetingError } = await supabase
      .from('video_sessions')
      .select('*')
      .eq('meeting_id', meetingId)
      .maybeSingle(); // Use maybeSingle()

    if (meetingError) {
      console.error('❌ Error fetching meeting:', meetingError);
      return res.status(400).json({ error: 'Error fetching meeting' });
    }

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Check if participant exists
    const { data: participant, error: participantError } = await supabase
      .from('profiles')
      .select('id, name')
      .eq('id', participantId)
      .maybeSingle(); // Use maybeSingle()

    if (participantError) {
      console.error('❌ Error fetching participant:', participantError);
      return res.status(400).json({ error: 'Error fetching participant' });
    }

    if (!participant) {
      return res.status(404).json({ error: 'Participant not found' });
    }

    // In a real implementation, this would call your video provider's API

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'remove_from_video_call',
            target_type: 'video_session',
            target_id: meeting.id,
            details: { meetingId, participantId, participantName: participant.name },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    res.json({
      meetingId,
      removedParticipant: participantId,
      message: 'Participant removed from video call successfully'
    });
  } catch (error) {
    console.error('❌ Error removing participant:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get admin actions log
app.get('/api/admin/actions', requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabase
      .from('admin_actions')
      .select(`
        *,
        admin:profiles(name)
      `, { count: 'exact' })
      .order('performed_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('❌ Error fetching admin actions:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({
      actions: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count
      }
    });
  } catch (error) {
    console.error('❌ Error fetching admin actions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard stats endpoint that returns counts
app.get('/api/admin/dashboard/stats', requireAdmin, async (req, res) => {
  try {
    console.log('📊 Fetching dashboard stats...');
    
    // Try to use cached data for counts
    const teachersData = getCache('teachers');
    const studentsData = getCache('students');
    const classesData = getCache('classes');
    
    let stats = {};
    
    // If we have all cached data, use it for counts
    if (teachersData && studentsData && classesData) {
      stats = {
        teachersCount: teachersData.length,
        studentsCount: studentsData.length,
        classesCount: classesData.length,
        totalUsers: teachersData.length + studentsData.length,
        fromCache: true
      };
      console.log('📊 Stats from cache:', stats);
    } else {
      console.log('📊 Fetching fresh stats from database...');
      
      // Fetch fresh counts from database
      const [teachersResult, studentsResult, classesResult] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact' }).eq('role', 'teacher'),
        supabase.from('profiles').select('id', { count: 'exact' }).eq('role', 'student'),
        supabase.from('classes').select('id', { count: 'exact' })
      ]);
      
      // Check for errors
      if (teachersResult.error) console.error('❌ Teachers count error:', teachersResult.error);
      if (studentsResult.error) console.error('❌ Students count error:', studentsResult.error);
      if (classesResult.error) console.error('❌ Classes count error:', classesResult.error);
      
      stats = {
        teachersCount: teachersResult.count || 0,
        studentsCount: studentsResult.count || 0,
        classesCount: classesResult.count || 0,
        totalUsers: (teachersResult.count || 0) + (studentsResult.count || 0),
        fromCache: false
      };
      
      console.log('📊 Fresh stats from database:', stats);
    }
    
    res.json(stats);
    
  } catch (error) {
    console.error('❌ Error fetching dashboard stats:', error);
    res.status(500).json({
      error: 'Failed to fetch dashboard stats',
      teachersCount: 0,
      studentsCount: 0,
      classesCount: 0,
      totalUsers: 0
    });
  }
});

// Update teacher status
app.patch('/api/admin/teachers/:id/status', requireAdmin, async (req, res) => {
  try {
    const teacherId = req.params.id;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', teacherId)
      .eq('role', 'teacher')
      .select();

    if (error) {
      console.error('❌ Error updating teacher status:', error);
      return res.status(400).json({ error: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'update_teacher_status',
            target_type: 'profile',
            target_id: teacherId,
            details: { status },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('teachers');

    res.json({ message: 'Teacher status updated successfully', teacher: data[0] });
  } catch (error) {
    console.error('❌ Error updating teacher status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update student status
app.patch('/api/admin/students/:id/status', requireAdmin, async (req, res) => {
  try {
    const studentId = req.params.id;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', studentId)
      .eq('role', 'student')
      .select();

    if (error) {
      console.error('❌ Error updating student status:', error);
      return res.status(400).json({ error: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'update_student_status',
            target_type: 'profile',
            target_id: studentId,
            details: { status },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('students');

    res.json({ message: 'Student status updated successfully', student: data[0] });
  } catch (error) {
    console.error('❌ Error updating student status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get unassigned students
app.get('/api/admin/students/unassigned', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'student')
      .is('teacher_id', null)
      .order('name');

    if (error) {
      console.error('❌ Error fetching unassigned students:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Error fetching unassigned students:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

//function requireteacher 
// function requireTeacher(req, res, next) {
//   if (!req.user || req.user.role !== 'teacher') {
//     return res.status(403).json({ error: 'Access denied: teacher only' });
//   }
//   next();
// }
// Assign student to teacher
app.post('/api/admin/students/:studentId/assign', requireAdmin, async (req, res) => {
  try {
    const { studentId } = req.params;
    const { teacher_id } = req.body;

    // Validate teacher_id
    if (!teacher_id) {
      return res.status(400).json({ error: 'Teacher ID is required.' });
    }

    // 1. Ensure the teacher exists in profiles and has role 'teacher'
    const { data: teacher, error: teacherError } = await supabase
      .from('profiles')
      .select('id, name, email')
      .eq('id', teacher_id)
      .eq('role', 'teacher')
      .single();

    if (teacherError || !teacher) {
      return res.status(404).json({ error: 'Teacher not found.' });
    }

    // 2. Ensure the student exists in profiles and has role 'student'
    // CHANGED: from 'students' table to 'profiles' table
    const { data: student, error: studentError } = await supabase
      .from('profiles')  // ← Changed to profiles table
      .select('id, name, email, teacher_id, role')
      .eq('id', studentId)
      .eq('role', 'student')  // ← Added role check
      .single();

    if (studentError || !student) {
      return res.status(404).json({ error: 'Student not found.' });
    }

    // 3. Update the student's teacher assignment in profiles table
    // CHANGED: from 'students' table to 'profiles' table
    const { data: updatedStudent, error: updateError } = await supabase
      .from('profiles')  // ← Changed to profiles table
      .update({ teacher_id })
      .eq('id', studentId)
      .select();

    if (updateError || !updatedStudent || updatedStudent.length === 0) {
      return res.status(400).json({ error: updateError?.message || 'Failed to assign student.' });
    }

    // 4. Log the assignment in a relationship/history table (for audit)
    await supabase
      .from('student_teachers')
      .upsert({
        student_id: studentId,
        teacher_id: teacher_id,
        assigned_by: req.user.id,
        assigned_at: new Date().toISOString()
      });

    // 5. Log admin action
    await supabase
      .from('admin_actions')
      .insert([
        {
          admin_id: req.user.id,
          action_type: 'assign_student',
          target_type: 'student',
          target_id: studentId,
          details: { 
            teacher_id, 
            teacher_name: teacher.name,
            teacher_email: teacher.email
          },
          performed_at: new Date().toISOString()
        }
      ]);

    // 6. Clear cache if used (optional)
    clearCache && clearCache('students');

    // 7. Respond with the updated student and teacher info
    return res.json({
      message: 'Student assigned successfully.',
      student: updatedStudent[0],
      teacher: teacher
    });

  } catch (error) {
    console.error('❌ Error assigning student:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Bulk assign students to teachers
app.post('/api/admin/students/bulk-assign', requireAdmin, async (req, res) => {
  try {
    const { assignments } = req.body;
    let assignedCount = 0;

    for (const assignment of assignments) {
      const { studentId, teacherId } = assignment;

      // Update each student
      const { error } = await supabase
        .from('profiles')
        .update({ teacher_id: teacherId })
        .eq('id', studentId)
        .eq('role', 'student');

      if (!error) {
        assignedCount++;
        
        // Create relationship record
        await supabase
          .from('student_teachers')
          .upsert({
            student_id: studentId,
            teacher_id: teacherId,
            assigned_by: req.user.id,
            assigned_at: new Date().toISOString()
          });
      }
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'bulk_assign_students',
            target_type: 'multiple',
            details: { assignments, assigned_count: assignedCount },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('students');

    res.json({ message: `Assigned ${assignedCount} students`, assigned: assignedCount });
  } catch (error) {
    console.error('❌ Error in bulk assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unassign student from teacher
app.post('/api/admin/students/:studentId/unassign', requireAdmin, async (req, res) => {
  try {
    const { studentId } = req.params;

    // Update student to remove teacher
    const { data, error: updateError } = await supabase
      .from('profiles')
      .update({ teacher_id: null })
      .eq('id', studentId)
      .eq('role', 'student')
      .select();

    if (updateError) {
      console.error('❌ Error unassigning student:', updateError);
      return res.status(400).json({ error: updateError.message });
    }

    // Remove student-teacher relationships
    const { error: relationshipError } = await supabase
      .from('student_teachers')
      .delete()
      .eq('student_id', studentId);

    if (relationshipError) {
      console.error('❌ Error removing student relationships:', relationshipError);
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'unassign_student',
            target_type: 'profile',
            target_id: studentId,
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️  Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('students');

    res.json({ 
      message: 'Student unassigned successfully',
      student: data[0]
    });
  } catch (error) {
    console.error('❌ Error unassigning student:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available teachers for assignment
app.get('/api/admin/teachers/available', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, name, email, subject, status')
      .eq('role', 'teacher')
      .eq('status', 'active')
      .order('name');

    if (error) {
      console.error('❌ Error fetching available teachers:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Error fetching available teachers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fees management endpoints
app.get('/api/admin/fees/students', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('students')  // Using students table as per schema
      .select(`
        *,
        teacher:teacher_id (name),
        fee_payments (*)
      `)
      .order('name');

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/api/admin/fees/statistics', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('fee_payments')
      .select('*');

    if (error) {
      console.error('❌ Error fetching fee statistics:', error);
      return res.status(400).json({ error: error.message });
    }

    const totalPaid = data
      .filter(p => p.status === 'confirmed')
      .reduce((sum, payment) => sum + payment.amount, 0);

    const pendingPayments = data.filter(p => p.status === 'pending').length;
    const confirmedPayments = data.filter(p => p.status === 'confirmed').length;

    res.json({
      totalPaid,
      pendingPayments,
      confirmedPayments,
      totalPayments: data.length
    });
  } catch (error) {
    console.error('❌ Error fetching fee statistics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/fees/confirm-payment', requireAdmin, async (req, res) => {
  try {
    const { paymentId, paymentMethod } = req.body;

    const { data, error } = await supabase
      .from('fee_payments')
      .update({
        status: 'confirmed',
        payment_method: paymentMethod,
        confirmed_at: new Date().toISOString()
      })
      .eq('id', paymentId)
      .select()
      .single();

    if (error) {
      console.error('❌ Error confirming payment:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Error confirming payment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/fees/reject-payment', requireAdmin, async (req, res) => {
  try {
    const { paymentId, reason } = req.body;

    const { data, error } = await supabase
      .from('fee_payments')
      .update({
        status: 'rejected',
        rejection_reason: reason,
        confirmed_at: null
      })
      .eq('id', paymentId)
      .select()
      .single();

    if (error) {
      console.error('❌ Error rejecting payment:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Error rejecting payment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get students by teacher ID
app.get('/api/admin/students/teacher/:teacherId', requireAdmin, async (req, res) => {
  try {
    const { teacherId } = req.params;

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'student')
      .eq('teacher_id', teacherId)
      .order('name');

    if (error) {
      console.error('❌ Error fetching students by teacher:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Error fetching students by teacher:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================================
// STUDENT ENDPOINTS 
// ==============================================

// Get dashboard statistics for a student
// Get dashboard statistics for a student - FIXED
app.get('/api/student/stats', requireAuth, async (req, res) => {
  try {
    const studentId = req.user.id;
    
    // Get profile stats
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('progress, attendance_rate, overall_score, completed_assignments, total_assignments')
      .eq('id', studentId)
      .single();

    if (profileError) {
      console.error('Profile error:', profileError);
      return res.status(500).json({ error: 'Failed to fetch profile data' });
    }

    // Get class count
    const { count: classCount, error: classError } = await supabase
      .from('students_classes')
      .select('*', { count: 'exact' })
      .eq('student_id', studentId);

    if (classError) {
      console.error('Class count error:', classError);
      return res.status(500).json({ error: 'Failed to fetch class count' });
    }

    // Get upcoming classes count
    const { data: upcomingClasses, error: upcomingError } = await supabase
      .from('classes')
      .select('id')
      .eq('students_classes.student_id', studentId)
      .gt('scheduled_date', new Date().toISOString())
      .lt('scheduled_date', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());

    if (upcomingError) {
      console.error('Upcoming classes error:', upcomingError);
      return res.status(500).json({ error: 'Failed to fetch upcoming classes' });
    }

    res.json({
      total_classes: classCount || 0,
      hours_learned: Math.floor((profile.attendance_rate || 0) * 50),
      assignments: profile.total_assignments || 0,
      avg_score: profile.overall_score || 0,
      upcoming_classes: upcomingClasses?.length || 0
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get all classes for a specific student - FIXED
app.get('/api/student/classes', requireAuth, async (req, res) => {
  try {
    const studentId = req.user.id;
    const { status } = req.query;

    // First get the class IDs for this student
    const { data: studentClasses, error: classError } = await supabase
      .from('students_classes')
      .select('class_id')
      .eq('student_id', studentId);

    if (classError) {
      console.error('Student classes error:', classError);
      return res.status(500).json({ error: 'Failed to fetch student classes' });
    }

    const classIds = studentClasses.map(sc => sc.class_id);

    if (classIds.length === 0) {
      return res.json([]);
    }

    // Now get the classes
    let query = supabase
      .from('classes')
      .select(`
        id,
        title,
        description,
        status,
        scheduled_date,
        end_date,
        duration,
        teacher:teacher_id (id, name, email),
        video_sessions (id, meeting_id, status, started_at)
      `)
      .in('id', classIds)
      .order('scheduled_date', { ascending: true });

    if (status === 'upcoming') {
      query = query.gt('scheduled_date', new Date().toISOString());
    } else if (status === 'completed') {
      query = query.lt('scheduled_date', new Date().toISOString());
    }

    const { data: classes, error } = await query;

    if (error) {
      console.error('Classes query error:', error);
      return res.status(500).json({ error: 'Failed to fetch classes' });
    }

    res.json(classes || []);

  } catch (error) {
    console.error('Classes error:', error);
    res.status(500).json({ error: 'Failed to fetch classes' });
  }
});

// Get assignments for a student - FIXED
app.get('/api/student/assignments', requireAuth, async (req, res) => {
  try {
    const studentId = req.user.id;
    const { status } = req.query;

    // First get the class IDs for this student
    const { data: studentClasses, error: classError } = await supabase
      .from('students_classes')
      .select('class_id')
      .eq('student_id', studentId);

    if (classError) {
      console.error('Student classes error:', classError);
      return res.status(500).json({ error: 'Failed to fetch student classes' });
    }

    const classIds = studentClasses.map(sc => sc.class_id);

    // Build the query
    let query = supabase
      .from('assignments')
      .select(`
        id,
        title,
        description,
        due_date,
        max_score,
        created_at,
        teacher:teacher_id (name),
        class:class_id (title),
        submissions (id, submitted_at, score, feedback, status)
      `)
      .or(`student_id.eq.${studentId},class_id.in.(${classIds.join(',')})`);

    if (status) {
      query = query.eq('submissions.status', status);
    }

    const { data: assignments, error } = await query;

    if (error) {
      console.error('Assignments error:', error);
      return res.status(500).json({ error: 'Failed to fetch assignments' });
    }

    res.json(assignments || []);

  } catch (error) {
    console.error('Assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Get payment history for a student - FIXED
app.get('/api/student/payments', requireAuth, async (req, res) => {
  try {
    const studentId = req.user.id;

    const { data: payments, error } = await supabase
      .from('fee_payments')
      .select(`
        id,
        amount,
        payment_method,
        status,
        payment_date,
        confirmed_at,
        transaction_code
      `)
      .eq('student_id', studentId)
      .order('payment_date', { ascending: false });

    if (error) {
      console.error('Payments error:', error);
      return res.status(500).json({ error: 'Failed to fetch payments' });
    }

    res.json(payments || []);

  } catch (error) {
    console.error('Payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});
// Student contact admin endpoint
app.post('/api/contact-admin', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    const studentId = req.user.id;

    // Get student info
    const { data: student } = await supabase
      .from('profiles')
      .select('name, email')
      .eq('id', studentId)
      .single();

    // Create notification
    const { error } = await supabase
      .from('admin_notifications')
      .insert({
        student_id: studentId,
        student_name: student.name,
        message: message,
        type: 'contact_request',
        status: 'pending'
      });

    if (error) throw error;

    res.json({ success: true, message: 'Message sent to admin successfully' });
  } catch (error) {
    console.error('Contact admin error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});




// Teacher endpoint 
//get classes for a specific teacher
app.get('/api/teacher/classes', requireAuth, async (req, res) => {
  try {
    console.log(`👨‍🏫 Fetching classes for teacher: ${req.user.name} (${req.user.id})`);

    // Minimal query - just tbasic class data
    const { data, error } = await supabase
      .from('classes')
      .select('*')
      .eq('teacher_id', req.user.id)
      .order('scheduled_date', { ascending: true });

    if (error) {
      console.error('❌ Error fetching teacher classes:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Fetched ${data?.length || 0} classes for teacher`);

    // Simple response with only existing columns
    const classes = (data || []).map(classItem => ({
      id: classItem.id,
      title: classItem.title || 'Untitled Class',
      description: classItem.description || '',
      teacher_id: classItem.teacher_id,
      status: classItem.status || 'scheduled',
      scheduled_date: classItem.scheduled_date,
      duration: classItem.duration || 60,
      max_students: classItem.max_students || 20
    }));

    res.json(classes);

  } catch (error) {
    console.error('❌ Error in teacher classes endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

//get stduents for specific teacher 
app.get('/api/teacher/students', requireAuth, async (req, res) => {
  try {
    console.log(`👨‍🏫 Fetching students for teacher: ${req.user.id}`);
    console.log(`📧 Teacher email: ${req.user.email}`);
    console.log(`🎯 Teacher role: ${req.user.role}`);

    if (req.user.role !== 'teacher') {
      console.log('❌ Access denied: User is not a teacher');
      return res.status(403).json({ error: 'Teacher access required' });
    }

    // Directly get students who have this teacher_id in their profile
    console.log(`🔍 Querying students with teacher_id: ${req.user.id}`);
    const { data: students, error } = await supabase
      .from('profiles')
      .select(`
        id,
        name,
        email,
        status,
        created_at,
        last_login_at,
        progress,
        attendance_rate,
        overall_score,
        completed_assignments,
        total_assignments,
        last_active
      `)
      .eq('teacher_id', req.user.id)
      .eq('role', 'student')
      .order('name', { ascending: true });

    if (error) {
      console.error('❌ Database error:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Fetched ${students?.length || 0} students`);
    console.log('📋 Student IDs:', students?.map(s => s.id) || []);
    
    res.json(students || []);

  } catch (error) {
    console.error('❌ Unexpected error in teacher students endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// assignments-  endpoints

// Get teacher's assignments
app.get('/api/teacher/assignments', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ error: 'Teacher access required' });
    }

    const { data: assignments, error } = await supabase
      .from('assignments')
      .select(`
        id,
        title,
        description,
        due_date,
        max_score,
        class_id,
        created_at,
        classes (title),
        assignment_submissions (
          id,
          student_id,
          submitted_at,
          score,
          feedback,
          status,
          students:student_id (name)
        )
      `)
      .eq('teacher_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Transform data with submission counts
    const transformed = assignments.map(assignment => {
      const submissions = assignment.assignment_submissions || [];
      return {
        id: assignment.id,
        title: assignment.title,
        description: assignment.description,
        due_date: assignment.due_date,
        max_score: assignment.max_score,
        class_id: assignment.class_id,
        class_title: assignment.classes?.title,
        created_at: assignment.created_at,
        submissions: submissions.map(sub => ({
          id: sub.id,
          student_id: sub.student_id,
          student_name: sub.students?.name,
          submitted_at: sub.submitted_at,
          score: sub.score,
          feedback: sub.feedback,
          status: sub.status
        })),
        submitted_count: submissions.length,
        graded_count: submissions.filter(s => s.score !== null).length,
        pending_count: submissions.filter(s => s.score === null).length
      };
    });

    res.json(transformed);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/api/test', (req, res) => {
  console.log('✅ Test endpoint hit');
  res.json({ message: 'API is working!', timestamp: new Date().toISOString() });
});

// Create new assignment
app.post('/api/teacher/assignments', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ error: 'Teacher access required' });
    }

    const { title, description, due_date, max_score, class_id, for_all_students } = req.body;

    // Create assignment
    const { data: assignment, error } = await supabase
      .from('assignments')
      .insert([{
        title,
        description,
        due_date,
        max_score,
        class_id,
        teacher_id: req.user.id,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // If for all students, create submissions for all students in the class
    if (for_all_students && class_id) {
      const { data: students, error: studentsError } = await supabase
        .from('students_classes')
        .select('student_id')
        .eq('class_id', class_id);

      if (!studentsError && students.length > 0) {
        const submissions = students.map(student => ({
          assignment_id: assignment.id,
          student_id: student.student_id,
          status: 'assigned',
          created_at: new Date().toISOString()
        }));

        await supabase
          .from('assignment_submissions')
          .insert(submissions);
      }
    }

    res.json(assignment);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Grade assignment submission
app.put('/api/teacher/assignments/:submissionId/grade', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ error: 'Teacher access required' });
    }

    const { submissionId } = req.params;
    const { score, feedback } = req.body;

    // Verify the teacher owns this assignment
    const { data: submission, error: verifyError } = await supabase
      .from('assignment_submissions')
      .select(`
        id,
        assignments (teacher_id)
      `)
      .eq('id', submissionId)
      .single();

    if (verifyError || submission.assignments.teacher_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to grade this assignment' });
    }

    const { error } = await supabase
      .from('assignment_submissions')
      .update({
        score,
        feedback,
        graded_at: new Date().toISOString(),
        status: 'graded'
      })
      .eq('id', submissionId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Assignment graded successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate Agora token (implement  later)
app.post('/api/generate-agora-token', async (req, res) => {
  try {
    const { channelName, userId, role = 'publisher' } = req.body;
    
    if (!channelName || !userId) {
      return res.status(400).json({ error: 'Channel name and user ID are required' });
    }

///
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  
  // Handle CORS errors specifically
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS error: Request not allowed' });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// Start server
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

export default app;