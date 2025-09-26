// routes/admin.js
// Admin-specific routes for managing users, classes, fees, and other administrative tasks.
// All routes are protected by requireAdmin middleware to ensure only authenticated admins can access them.

import express from 'express';
import { supabase, clearCache, getCache, setCache } from '../server.js';
import { requireAdmin } from '../middleware/auth.js';
import { generateSecurePassword, sanitizeInput } from '../utils/helpers.js';

const router = express.Router();

// Apply admin authentication middleware to all routes
router.use(requireAdmin);

// Placeholder for sendAdminWelcomeEmail function (to be implemented based on email provider)
async function sendAdminWelcomeEmail(email, name) {
  // This is a placeholder for sending a custom welcome email
  // In a real implementation, this would use an email service like Resend
  console.log(`📧 Placeholder: Sending welcome email to ${email} for ${name}`);
}

// Admin registration endpoint with error handling
router.post('/register', async (req, res) => {
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
      email_confirm: !sendConfirmationEmail,
      user_metadata: { name, role: 'admin' }
    });

    // Create auth user - with email confirmation based on sendConfirmationEmail flag
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: !sendConfirmationEmail,
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
      
      let errorMessage = authError.message;
      if (authError.message?.includes('Email')) {
        errorMessage = 'Email configuration issue. Please check SMTP settings.';
      }
      
      return res.status(400).json({ error: errorMessage });
    }

    console.log('✅ Auth user created:', authData.user.id);
    
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
        await supabase.auth.admin.deleteUser(authData.user.id);
        return res.status(400).json({ error: 'Failed to update profile: ' + profileError.message });
      }
      
      profileData = data;
    } else {
      console.log('📝 Creating new profile...');
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
        await supabase.auth.admin.deleteUser(authData.user.id);
        return res.status(400).json({ error: 'Failed to create profile: ' + profileError.message });
      }
      
      profileData = data;
    }

    console.log('✅ Profile handled:', profileData);

    if (sendConfirmationEmail) {
      try {
        await sendAdminWelcomeEmail(email, name);
        console.log('📧 Custom admin welcome email sent');
      } catch (emailError) {
        console.error('⚠️ Failed to send welcome email:', emailError);
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

// Admin login endpoint - FIXED
router.post('/login', async (req, res) => {
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
router.post('/logout', async (req, res) => {
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

// Activate admin account
router.post('/activate', async (req, res) => {
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

// Create teacher
router.post('/teachers', async (req, res) => {
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

    // Log action
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

// Reset teacher password
router.post('/teachers/:teacherId/reset-password', async (req, res) => {
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
    const newPassword = generateSecurePassword(12);

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
router.delete('/teachers/:id', async (req, res) => {
  try {
    const teacherId = req.params.id;

    // Check if teacher exists
    const { data: teacher, error: fetchError } = await supabase
      .from('profiles')
      .select('id, name, email')
      .eq('id', teacherId)
      .eq('role', 'teacher')
      .maybeSingle();

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
      console.warn('⚠️ Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('teachers');

    res.json({ message: 'Teacher removed successfully' });
  } catch (error) {
    console.error('❌ Error removing teacher:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create student with teacher assignment
router.post('/students', async (req, res) => {
  try {
    const { name, email, course, teacher_id } = req.body;

    if (!name || !email || !course || !teacher_id) {
      return res.status(400).json({ error: 'Missing required fields: name, email, course, teacher_id' });
    }

    // Check if student already exists
    const { data: existingStudent, error: checkError } = await supabase
      .from('profiles')
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
    const password = generateSecurePassword();

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

    // Create profile with student and teacher assignment
    const { error: profileError } = await supabase
      .from('profiles')
      .insert([
        {
          id: authData.user.id,
          email,
          name,
          role: 'student',
          course,
          teacher_id,
          status: 'active',
          created_at: new Date().toISOString()
        }
      ]);

    if (profileError) {
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
      console.warn('⚠️ Failed to log admin action:', logError);
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

// route for student assignment
router.post('/students/:studentId/assign', async (req, res) => {
  try {
    const { studentId } = req.params;
    const { teacher_id } = req.body;

    if (!teacher_id) {
      return res.status(400).json({ error: 'Teacher ID is required' });
    }

    console.log(`👥 Assigning student ${studentId} to teacher ${teacher_id}`);

    // Check if student exists
    const { data: student, error: studentError } = await supabase
      .from('profiles')
      .select('id, name, email')
      .eq('id', studentId)
      .eq('role', 'student')
      .single();

    if (studentError || !student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Check if teacher exists
    const { data: teacher, error: teacherError } = await supabase
      .from('profiles')
      .select('id, name, email')
      .eq('id', teacher_id)
      .eq('role', 'teacher')
      .single();

    if (teacherError || !teacher) {
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
      console.error('❌ Error assigning student:', updateError);
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
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'assign_student',
            target_type: 'profile',
            target_id: studentId,
            details: { 
              student_name: student.name, 
              teacher_id, 
              teacher_name: teacher.name 
            },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('students');

    res.json({ 
      message: 'Student assigned successfully',
      student: data[0],
      teacher: teacher.name
    });
  } catch (error) {
    console.error('❌ Error assigning student:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reassign student to different teacher
router.patch('/students/:id/reassign', async (req, res) => {
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
      console.warn('⚠️ Failed to log admin action:', logError);
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
router.delete('/students/:id', async (req, res) => {
  try {
    const studentId = req.params.id;

    // Check if student exists
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

    // Remove student-teacher relationships
    const { error: relationshipError } = await supabase
      .from('student_teachers')
      .delete()
      .eq('student_id', studentId);

    if (relationshipError) {
      console.error('❌ Error removing student relationships:', relationshipError);
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
      console.warn('⚠️ Failed to log admin action:', logError);
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
router.get('/teachers', async (req, res) => {
  try {
    console.log('📚 Fetching teachers...');
    
    // Check cache first
    const cachedData = getCache('teachers');
    if (cachedData) {
      return res.json(cachedData);
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

    res.json(data || []);
  } catch (error) {
    console.error('❌ Error fetching teachers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all students with caching
router.get('/students', async (req, res) => {
  try {
    console.log('👥 Fetching students from profiles table...');
    
    // Check cache first
    const cachedData = getCache('students');
    if (cachedData) {
      console.log('📦 Cache hit for: students');
      return res.json(cachedData);
    }

    console.log('❌ Cache miss for: students - fetching from profiles table');

    // Fetch students from profiles table
    const { data, error } = await supabase
      .from('profiles')
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
      .eq('role', 'student')
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

    res.json(studentsWithTeacherInfo || []);
  } catch (error) {
    console.error('❌ Error fetching students:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get students by teacher ID
router.get('/students/teacher/:teacherId', async (req, res) => {
  try {
    const { teacherId } = req.params;

    // Check if teacher exists
    const { data: teacher, error: teacherError } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', teacherId)
      .eq('role', 'teacher')
      .maybeSingle();

    if (teacherError) {
      console.error('❌ Error fetching teacher:', teacherError);
      return res.status(400).json({ error: 'Error fetching teacher' });
    }

    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .select(`
        id,
        name,
        email,
        course,
        status,
        created_at,
        updated_at
      `)
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
router.get('/profile', async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, name, email, role, status, created_at, updated_at')
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

// Schedule classes
router.post('/classes', async (req, res) => {
  try {
    const { 
      title, 
      teacher_id, 
      scheduled_date, 
      duration, 
      max_students, 
      description, 
      recurring, 
      recurrence_type, 
      recurrence_days, 
      recurrence_interval 
    } = req.body;
    
    // Validate input
    if (!title || !teacher_id || !scheduled_date) {
      return res.status(400).json({ error: 'Title, teacher ID, and scheduled date are required' });
    }

    // Check if teacher exists
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
    let classesToCreate = [];
    const baseClassData = {
      title,
      teacher_id,
      duration: duration || 60,
      max_students: max_students || 20,
      description: description || '',
      status: 'scheduled',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (recurring && recurrence_type && recurrence_type !== 'none') {
      const startDate = new Date(scheduled_date);
      const totalDays = recurrence_days || 30;
      const interval = recurrence_interval || 1;
      
      let currentDate = new Date(startDate);
      let occurrenceCount = 0;
      const maxOccurrences = 50; // Safety limit

      while (occurrenceCount < maxOccurrences) {
        classesToCreate.push({
          ...baseClassData,
          scheduled_date: currentDate.toISOString(),
          recurrence_type,
          recurrence_sequence: occurrenceCount,
          is_recurring: true
        });

        occurrenceCount++;
        
        // Calculate next date based on recurrence type
        const nextDate = new Date(currentDate);
        switch (recurrence_type) {
          case 'daily':
            nextDate.setDate(currentDate.getDate() + interval);
            break;
          case 'weekly':
            nextDate.setDate(currentDate.getDate() + (7 * interval));
            break;
          case 'monthly':
            nextDate.setMonth(currentDate.getMonth() + interval);
            break;
          default:
            break;
        }

        // Stop if we've exceeded the recurrence days
        const daysDiff = Math.floor((nextDate - startDate) / (1000 * 60 * 60 * 24));
        if (daysDiff >= totalDays) break;

        currentDate = nextDate;
      }
    } else {
      // Single class
      classesToCreate.push({
        ...baseClassData,
        scheduled_date: new Date(scheduled_date).toISOString(),
        is_recurring: false
      });
    }

    // Insert classes into database
    const { data: createdClasses, error: insertError } = await supabase
      .from('classes')
      .insert(classesToCreate)
      .select(`
        *,
        teacher:teacher_id (id, name, email)
      `);

    if (insertError) {
      console.error('❌ Error creating classes:', insertError);
      return res.status(400).json({ error: insertError.message });
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert(
          createdClasses.map(cls => ({
            admin_id: req.user.id,
            action_type: 'create_class',
            target_type: 'class',
            target_id: cls.id,
            details: { 
              title: cls.title, 
              teacher_id, 
              scheduled_date: cls.scheduled_date,
              is_recurring: cls.is_recurring,
              recurrence_type: cls.recurrence_type
            },
            performed_at: new Date().toISOString()
          }))
        );
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('classes');

    res.status(201).json({
      message: classesToCreate.length > 1 
        ? `Scheduled ${classesToCreate.length} recurring classes` 
        : 'Class scheduled successfully',
      classes: createdClasses,
      total_occurrences: classesToCreate.length
    });

  } catch (error) {
    console.error('❌ Error scheduling class:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});// Get all classes with filtering
router.get('/classes', async (req, res) => {
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
router.put('/classes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Validate updates
    if (updates.teacher_id) {
      const { data: teacher, error: teacherError } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', updates.teacher_id)
        .eq('role', 'teacher')
        .single();

      if (teacherError || !teacher) {
        return res.status(400).json({ error: 'Invalid teacher ID' });
      }
    }

    const { data: classData, error } = await supabase
      .from('classes')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
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

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'update_class',
            target_type: 'class',
            target_id: id,
            details: updates,
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('classes');

    res.json(classData);
  } catch (error) {
    console.error('Error updating class:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete class
router.delete('/classes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if class exists
    const { data: classData, error: fetchError } = await supabase
      .from('classes')
      .select('id, title')
      .eq('id', id)
      .single();

    if (fetchError || !classData) {
      console.error('Error fetching class:', fetchError);
      return res.status(404).json({ error: 'Class not found' });
    }

    const { error } = await supabase
      .from('classes')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting class:', error);
      return res.status(400).json({ error: error.message });
    }

    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'delete_class',
            target_type: 'class',
            target_id: id,
            details: { title: classData.title },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('classes');

    res.json({ message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Error deleting class:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Add these fee management routes to admin.js

// Get students with fee information
router.get('/fees/students', async (req, res) => {
  try {
    console.log('💰 Fetching students with fee information...');
    
    const { data: students, error } = await supabase
      .from('profiles')
      .select(`
        id,
        name,
        email,
        course,
        status,
        created_at,
        teacher:teacher_id (name, email)
      `)
      .eq('role', 'student')
      .order('name');

    if (error) {
      console.error('❌ Error fetching students for fees:', error);
      return res.status(400).json({ error: error.message });
    }

    // Add mock fee data (replace with actual fee logic when implemented)
    const studentsWithFees = students.map(student => ({
      ...student,
      fee_status: 'paid', // Mock data
      amount_paid: 100, // Mock data
      payment_date: new Date().toISOString(), // Mock data
      payment_method: 'bank_transfer' // Mock data
    }));

    res.json(studentsWithFees);
  } catch (error) {
    console.error('❌ Error in fees/students:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get fee statistics
router.get('/fees/statistics', async (req, res) => {
  try {
    console.log('📊 Fetching fee statistics...');
    
    // Get all students
    const { data: students, error } = await supabase
      .from('profiles')
      .select('id, status')
      .eq('role', 'student');

    if (error) {
      console.error('❌ Error fetching students for statistics:', error);
      return res.status(400).json({ error: error.message });
    }

    // Mock statistics (replace with actual fee calculations)
    const totalStudents = students.length;
    const activeStudents = students.filter(s => s.status === 'active').length;
    
    const statistics = {
      total_students: totalStudents,
      active_students: activeStudents,
      total_revenue: totalStudents * 100, // Mock data
      paid_students: Math.floor(activeStudents * 0.8), // Mock data - 80% paid
      pending_payments: Math.floor(activeStudents * 0.2), // Mock data - 20% pending
      overdue_payments: Math.floor(activeStudents * 0.05), // Mock data - 5% overdue
      monthly_revenue: 5000, // Mock data
      average_fee: 100 // Mock data
    };

    res.json(statistics);
  } catch (error) {
    console.error('❌ Error in fees/statistics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Confirm payment
router.post('/fees/confirm-payment', async (req, res) => {
  try {
    const { paymentId, paymentMethod } = req.body;
    
    if (!paymentId) {
      return res.status(400).json({ error: 'Payment ID is required' });
    }

    // Mock payment confirmation (replace with actual payment processing)
    console.log(`✅ Payment ${paymentId} confirmed via ${paymentMethod}`);
    
    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'confirm_payment',
            target_type: 'payment',
            target_id: paymentId,
            details: { paymentMethod },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️ Failed to log payment confirmation:', logError);
    }

    res.json({ 
      message: 'Payment confirmed successfully',
      paymentId,
      confirmedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error confirming payment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject payment
router.post('/fees/reject-payment', async (req, res) => {
  try {
    const { paymentId, reason } = req.body;
    
    if (!paymentId || !reason) {
      return res.status(400).json({ error: 'Payment ID and reason are required' });
    }

    // Mock payment rejection
    console.log(`❌ Payment ${paymentId} rejected: ${reason}`);
    
    // Log admin action
    try {
      await supabase
        .from('admin_actions')
        .insert([
          {
            admin_id: req.user.id,
            action_type: 'reject_payment',
            target_type: 'payment',
            target_id: paymentId,
            details: { reason },
            performed_at: new Date().toISOString()
          }
        ]);
    } catch (logError) {
      console.warn('⚠️ Failed to log payment rejection:', logError);
    }

    res.json({ 
      message: 'Payment rejected successfully',
      paymentId,
      reason,
      rejectedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error rejecting payment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get live video sessions
router.get('/video-sessions', async (req, res) => {
  try {
    const { status, start_date, end_date } = req.query;

    let query = supabase
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
      `);

    if (status) query = query.eq('status', status);
    if (start_date) query = query.gte('started_at', start_date);
    if (end_date) query = query.lte('started_at', end_date);

    query = query.order('started_at', { ascending: false });

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching video sessions:', error);
      return res.status(400).json({ error: error.message });
    }

    const sessions = (data || []).map(session => ({
      ...session,
      start_time: session.started_at,
      description: session.agenda,
      title: session.classes?.title,
      teacher_name: session.profiles?.name,
      teacher_email: session.profiles?.email
    }));

    res.json(sessions);
  } catch (error) {
    console.error('Error fetching video sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Join video call as admin
router.post('/join-video-call', async (req, res) => {
  try {
    const { meetingId } = req.body;

    if (!meetingId) {
      return res.status(400).json({ error: 'Meeting ID is required' });
    }

    // Check if meeting exists
    const { data: meeting, error: meetingError } = await supabase
      .from('video_sessions')
      .select('id, meeting_id, class_id, teacher_id, status, channel_name')
      .eq('meeting_id', meetingId)
      .maybeSingle();

    if (meetingError) {
      console.error('❌ Error fetching meeting:', meetingError);
      return res.status(400).json({ error: 'Error fetching meeting' });
    }

    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    // Generate token (placeholder for actual video provider integration)
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
      console.warn('⚠️ Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('liveSessions');

    res.json({
      meetingId,
      adminToken,
      channelName: meeting.channel_name,
      message: 'Admin joined video call successfully'
    });
  } catch (error) {
    console.error('❌ Error joining video call:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove participant from video call
router.post('/remove-from-video-call', async (req, res) => {
  try {
    const { meetingId, participantId } = req.body;

    if (!meetingId || !participantId) {
      return res.status(400).json({ error: 'Meeting ID and Participant ID are required' });
    }

    // Check if meeting exists
    const { data: meeting, error: meetingError } = await supabase
      .from('video_sessions')
      .select('id, meeting_id')
      .eq('meeting_id', meetingId)
      .maybeSingle();

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
      .maybeSingle();

    if (participantError) {
      console.error('❌ Error fetching participant:', participantError);
      return res.status(400).json({ error: 'Error fetching participant' });
    }

    if (!participant) {
      return res.status(404).json({ error: 'Participant not found' });
    }

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
      console.warn('⚠️ Failed to log admin action:', logError);
    }

    // Clear cache
    clearCache('liveSessions');

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

export default router;
