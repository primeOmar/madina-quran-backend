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

// middleware/auth.js - Add these student middleware functions

// Student middleware: Verifies if the user is a student
const requireStudent = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      console.log('❌ No token provided for student access');
      return res.status(401).json({ error: 'Authentication required' });
    }

    console.log('🔐 Verifying student token...');

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      console.error('❌ Student token verification failed:', authError);
      return res.status(401).json({ error: 'Invalid token' });
    }

    console.log('✅ Student user authenticated:', user.email);

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, name, email, role, status, student_id, class_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.error('❌ Student profile not found:', profileError);
      return res.status(404).json({ error: 'Student profile not found' });
    }

    if (profile.role !== 'student') {
      console.error('❌ Access denied - not a student:', profile.role);
      return res.status(403).json({ error: 'Student privileges required' });
    }

    if (profile.status !== 'active') {
      console.log('❌ Student account is not active:', profile.status);
      return res.status(403).json({ error: 'Student account is not active' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      ...profile
    };

    console.log(`✅ Student verified: ${profile.name}, Student ID: ${profile.student_id}`);
    next();

  } catch (error) {
    console.error('❌ Student middleware error:', error);
    res.status(500).json({ error: 'Student verification failed' });
  }
};

// Student with active enrollment middleware: Verifies student has active class enrollment
const requireEnrolledStudent = async (req, res, next) => {
  try {
    // First verify basic student authentication
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get student profile with enrollment details
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select(`
        id, 
        name, 
        email, 
        role, 
        status, 
        student_id,
        class_id,
        classes:class_id (
          id,
          name,
          status,
          teacher_id
        )
      `)
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Student profile not found' });
    }

    if (profile.role !== 'student') {
      return res.status(403).json({ error: 'Student privileges required' });
    }

    if (profile.status !== 'active') {
      return res.status(403).json({ error: 'Student account is not active' });
    }

    // Check if student is enrolled in a class
    if (!profile.class_id) {
      return res.status(403).json({ 
        error: 'Student is not enrolled in any class',
        code: 'NO_ENROLLMENT'
      });
    }

    // Check if the enrolled class is active
    if (profile.classes && profile.classes.status !== 'active') {
      return res.status(403).json({ 
        error: 'Enrolled class is not active',
        code: 'CLASS_INACTIVE'
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      ...profile,
      class_info: profile.classes
    };

    console.log(`✅ Enrolled student verified: ${profile.name}, Class: ${profile.classes?.name}`);
    next();

  } catch (error) {
    console.error('❌ Enrolled student middleware error:', error);
    res.status(500).json({ error: 'Student enrollment verification failed' });
  }
};

// Student with specific class access middleware
const requireStudentClassAccess = async (req, res, next) => {
  try {
    // First get the student using basic student middleware logic
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { data: { user } } = await supabase.auth.getUser(token);
    
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role, status, class_id')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'student' || profile.status !== 'active') {
      return res.status(403).json({ error: 'Valid student required' });
    }

    // Check if student has access to the requested class (if class ID is in route params)
    if (req.params.classId) {
      if (profile.class_id !== req.params.classId) {
        return res.status(403).json({ error: 'Access denied to this class' });
      }
    }

    // Check if student has access to the requested assignment (if assignment ID is provided)
    if (req.body.assignment_id || req.params.assignmentId) {
      const assignmentId = req.body.assignment_id || req.params.assignmentId;
      
      const { data: assignment } = await supabase
        .from('assignments')
        .select('class_id')
        .eq('id', assignmentId)
        .single();

      if (assignment && assignment.class_id !== profile.class_id) {
        return res.status(403).json({ error: 'Access denied to this assignment' });
      }
    }

    req.user = { id: user.id, ...profile };
    next();

  } catch (error) {
    console.error('❌ Student class access middleware error:', error);
    res.status(500).json({ error: 'Access verification failed' });
  }
};

export { 
  requireAdmin, 
  requireAuth, 
  requireTeacher, 
  requireStudent, 
  requireEnrolledStudent, 
  requireStudentClassAccess 
};
