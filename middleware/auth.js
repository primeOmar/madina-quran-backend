// middleware/auth.js
// Authentication middleware for verifying admin, teacher, and general user access.

import { supabase } from '../server.js';

// Admin middleware: Verifies if the user is an active admin
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

// General authentication middleware: Verifies if the user is authenticated and active
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

// Teacher middleware: Verifies if the user is a teacher
const requireTeacher = async (req, res, next) => {
  if (!req.user || req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Access denied: teacher only' });
  }
  next();
};

export { requireAdmin, requireAuth, requireTeacher };