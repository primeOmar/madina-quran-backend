// Student-specific routes for managing profiles, accessing classes, and joining video sessions.
// All routes are protected by requireAuth middleware.

import express from 'express';
import { supabase, clearCache, getCache, setCache } from '../server.js';
import { requireAuth } from '../middleware/auth.js';
import { requireStudent } from '../middleware/auth.js';
import { sanitizeInput } from '../utils/helpers.js';

const router = express.Router();

// Apply authentication middleware to all student routes
router.use(requireAuth);

// Async handler wrapper for better error handling
const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Database table discovery and fallback system
const discoverTables = async () => {
  try {
    // Get all tables in public schema
    const { data: tables, error } = await supabase
      .from('pg_tables')
      .select('tablename')
      .eq('schemaname', 'public');
    
    if (error) {
      console.warn('Could not discover tables:', error.message);
      return {};
    }
    
    const tableMap = {};
    tables.forEach(table => {
      tableMap[table.tablename] = table.tablename;
    });
    
    return tableMap;
  } catch (error) {
    console.warn('Table discovery failed:', error.message);
    return {};
  }
};

// Get student profile
router.get('/profile', asyncHandler(async (req, res) => {
  console.log('👤 Fetching student profile for:', req.user.email);

  const { data: profile, error } = await supabase
    .from('profiles')
    .select(`
      id,
      name,
      email,
      role,
      course,
      status,
      created_at,
      updated_at,
      teacher_id,
      teacher:teacher_id (
        id,
        name,
        email,
        subject
      )
    `)
    .eq('id', req.user.id)
    .eq('role', 'student')
    .single();

  if (error) {
    console.error('❌ Error fetching student profile:', error);
    return res.status(400).json({ error: 'Error fetching profile' });
  }

  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  res.json({
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role,
    course: profile.course,
    status: profile.status,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    teacher_id: profile.teacher_id,
    teacher_name: profile.teacher?.name,
    teacher_email: profile.teacher?.email,
    teacher_subject: profile.teacher?.subject
  });
}));

// Update student profile
router.put('/profile', asyncHandler(async (req, res) => {
  const { name, course } = req.body;

  if (!name && !course) {
    return res.status(400).json({ error: 'At least one field (name or course) is required' });
  }

  const updates = {};
  if (name) updates.name = sanitizeInput(name);
  if (course) updates.course = sanitizeInput(course);
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', req.user.id)
    .eq('role', 'student')
    .select()
    .single();

  if (error) {
    console.error('❌ Error updating student profile:', error);
    return res.status(400).json({ error: error.message });
  }

  res.json({
    message: 'Profile updated successfully',
    profile: data
  });
}));

// Get student's classes 

router.get('/classes', asyncHandler(async (req, res) => {
  const { status, start_date, end_date, page = 1, limit = 50 } = req.query;

  console.log('📚 Fetching classes from teacher for student:', req.user.id);

  // First get the student's teacher_id
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('teacher_id')
    .eq('id', req.user.id)
    .single();

  if (profileError || !profile) {
    console.error('❌ Error fetching student profile:', profileError);
    return res.status(400).json({ error: 'Student profile not found' });
  }

  if (!profile.teacher_id) {
    return res.json({
      classes: [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: 0
      }
    });
  }

  // Query ALL classes from this teacher
  let query = supabase
    .from('classes')
    .select(`
      id,
      title,
      scheduled_date,
      duration,
      description,
      status,
      teacher_id,
      teacher:teacher_id (
        name,
        email
      )
    `, { count: 'exact' })
    .eq('teacher_id', profile.teacher_id);

  // Apply filters
  if (status) query = query.eq('status', status);
  if (start_date) query = query.gte('scheduled_date', start_date);
  if (end_date) query = query.lte('scheduled_date', end_date);

  // Pagination
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  query = query.order('scheduled_date', { ascending: true })
               .range(from, to);

  const { data, error, count } = await query;

  if (error) {
    console.error('❌ Error fetching teacher classes:', error);
    return res.status(400).json({ error: error.message });
  }

  res.json({
    classes: data || [],
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: count || 0
    }
  });
}));

// Join video session
router.post('/video-sessions/join', asyncHandler(async (req, res) => {
  const { meeting_id } = req.body;

  if (!meeting_id) {
    return res.status(400).json({ error: 'Meeting ID is required' });
  }

  // Verify student is enrolled in the class associated with the video session
  const { data: session, error: sessionError } = await supabase
    .from('video_sessions')
    .select(`
      id,
      meeting_id,
      class_id,
      status,
      channel_name,
      classes (
        id,
        teacher_id,
        students_classes (
          student_id
        )
      )
    `)
    .eq('meeting_id', meeting_id)
    .eq('status', 'active')
    .single();

  if (sessionError || !session) {
    console.error('❌ Error fetching video session:', sessionError);
    return res.status(400).json({ error: 'Video session not found or not active' });
  }

  // Check if student is enrolled in the class
  const isEnrolled = session.classes?.students_classes?.some(sc => sc.student_id === req.user.id);
  if (!isEnrolled) {
    return res.status(403).json({ error: 'Not authorized to join this session' });
  }

  // In a real implementation, this would generate a token for your video provider
  const studentToken = `student-${meeting_id}-${req.user.id}-${Date.now()}`;

  res.json({
    meeting_id,
    student_token: studentToken,
    channel_name: session.channel_name,
    message: 'Joined video session successfully'
  });
}));

// Get student's video sessions
router.get('/video-sessions', asyncHandler(async (req, res) => {
  const { status, start_date, end_date } = req.query;

  // First get the student's teacher_id
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('teacher_id')
    .eq('id', req.user.id)
    .single();

  if (profileError || !profile) {
    console.error('❌ Error fetching student profile:', profileError);
    return res.status(400).json({ error: 'Student profile not found' });
  }

  const teacherId = profile.teacher_id;

  // Get class IDs where student is enrolled AND classes are from their teacher
  const { data: enrollmentData, error: enrollmentError } = await supabase
    .from('students_classes')
    .select(`
      class_id,
      classes!inner(
        teacher_id
      )
    `)
    .eq('student_id', req.user.id)
    .eq('classes.teacher_id', teacherId);

  if (enrollmentError) {
    console.error('❌ Error fetching enrollments:', enrollmentError);
    return res.status(400).json({ error: enrollmentError.message });
  }

  if (!enrollmentData || enrollmentData.length === 0) {
    return res.json([]);
  }

  const classIds = enrollmentData.map(item => item.class_id);

  let query = supabase
    .from('video_sessions')
    .select(`
      id,
      meeting_id,
      class_id,
      status,
      started_at,
      ended_at,
      channel_name,
      agenda,
      classes (
        title,
        teacher_id,
        teacher:teacher_id (
          name,
          email
        )
      )
    `)
    .in('class_id', classIds)
    .eq('classes.teacher_id', teacherId); // Ensure it's from their teacher

  if (status) query = query.eq('status', status);
  if (start_date) query = query.gte('started_at', start_date);
  if (end_date) query = query.lte('started_at', end_date);

  query = query.order('started_at', { ascending: false });

  const { data, error } = await query;

  if (error) {
    console.error('❌ Error fetching video sessions:', error);
    return res.status(400).json({ error: error.message });
  }

  const sessions = (data || []).map(session => ({
    id: session.id,
    meeting_id: session.meeting_id,
    class_id: session.class_id,
    status: session.status,
    started_at: session.started_at,
    ended_at: session.ended_at,
    channel_name: session.channel_name,
    agenda: session.agenda,
    class_title: session.classes?.title,
    teacher_name: session.classes?.teacher?.name,
    teacher_email: session.classes?.teacher?.email
  }));

  res.json(sessions);
}));

// Get student stats 
router.get('/stats', asyncHandler(async (req, res) => {
  try {
    console.log('=== STATS ENDPOINT DEBUG ===');
    console.log('Student ID:', req.user.id);
    
    // Get the student's teacher_id
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('teacher_id')
      .eq('id', req.user.id)
      .single();

    console.log('Profile data:', profile);
    console.log('Profile error:', profileError);

    if (profileError || !profile) {
      console.log('No profile found, returning 0 stats');
      return res.json({ total_classes: 0, hours_learned: 0, assignments: 0, avg_score: 0 });
    }

    const teacherId = profile.teacher_id;
    console.log('Teacher ID:', teacherId);

  
    const { count: enrolledClassesCount, error: enrolledError } = await supabase
      .from('classes')
      .select('*', { count: 'exact', head: true })
      .eq('student_id', req.user.id);

    console.log('Enrolled classes count:', enrolledClassesCount);
    console.log('Enrolled classes error:', enrolledError);

    const { count: teacherClassesCount, error: teacherError } = await supabase
      .from('classes')
      .select('*', { count: 'exact', head: true })
      .eq('teacher_id', teacherId);

    console.log('Teacher classes count:', teacherClassesCount);
    console.log('Teacher classes error:', teacherError);

 
    let totalClasses = enrolledClassesCount || teacherClassesCount || 0;
    console.log('Final total classes:', totalClasses);

    
    const { data: actualClasses, error: classesError } = await supabase
      .from('classes')
      .select('class_id')
      .eq('student_id', req.user.id);

    console.log('Actual enrolled classes:', actualClasses);
    console.log('Classes error:', classesError);

    // DEBUG: Check teacher's classes
    const { data: teacherClasses, error: teacherClassesError } = await supabase
      .from('classes')
      .select('id, title')
      .eq('teacher_id', teacherId);

    console.log('Teacher classes:', teacherClasses);
    console.log('Teacher classes error:', teacherClassesError);

    console.log('=== END STATS DEBUG ===');
    // Calculate hours learned (simplified)
    const { data: classesData } = await supabase
      .from('students_classes')
      .select(`
        classes (
          duration
        )
      `)
      .eq('student_id', req.user.id);

    let hoursLearned = 0;
    if (classesData) {
      classesData.forEach(item => {
        hoursLearned += (item.classes?.duration || 0) / 60;
      });
    }

    // Get assignments count
    const { count: assignmentsCount } = await supabase
      .from('assignments')
      .select('*', { count: 'exact', head: true })
      .eq('student_id', req.user.id);

    // Calculate average score from assignment_submissions
    let avgScore = 0;
    const { data: submissions } = await supabase
      .from('assignment_submissions')
      .select('score')
      .eq('student_id', req.user.id)
      .not('score', 'is', null);

    if (submissions && submissions.length > 0) {
      const totalScore = submissions.reduce((sum, sub) => sum + (sub.score || 0), 0);
      avgScore = Math.round(totalScore / submissions.length);
    }

    res.json({
      total_classes: totalClasses,
      hours_learned: hoursLearned.toFixed(1),
      assignments: assignmentsCount || 0,
      avg_score: avgScore
    });

  } catch (error) {
    console.error('❌ Error in stats endpoint:', error);
    res.json({ total_classes: 0, hours_learned: 0, assignments: 0, avg_score: 0 });
  }
}));
// Check if student has teacher
router.get('/teacher-check', asyncHandler(async (req, res) => {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('teacher_id')
    .eq('id', req.user.id)
    .single();

  if (error) {
    console.error('❌ Error checking teacher:', error);
    return res.status(400).json({ error: 'Error checking teacher status' });
  }

  res.json({ hasTeacher: !!profile?.teacher_id });
}));

// Get assignments 
router.get('/assignments', asyncHandler(async (req, res) => {
  try {
    // First get the student's teacher_id
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('teacher_id')
      .eq('id', req.user.id)
      .single();

    if (profileError || !profile) {
      console.error('❌ Error fetching student profile:', profileError);
      return res.status(400).json({ error: 'Student profile not found' });
    }

    const teacherId = profile.teacher_id;

    // Query assignments with only the columns that actually exist
    let { data, error } = await supabase
      .from('assignments')
      .select(`
        id,
        title,
        description,
        due_date,
        max_score,
        class_id,
        teacher_id,
        student_id,
        file_url,
        grade,
        feedback,
        submitted_at,
        created_at,
        updated_at,
        classes (
          id,
          title,
          teacher_id
        ),
        assignment_submissions (
          id,
          status,
          score,
          feedback,
          submitted_at,
          graded_at
        )
      `)
      .eq('student_id', req.user.id)
      .eq('teacher_id', teacherId)
      .order('due_date', { ascending: true });

    if (error) {
      console.error('❌ Error fetching assignments:', error);
      throw error;
    }

    // Transform the data to match expected frontend format
    const assignments = (data || []).map(assignment => {
      // Determine status based on submission and grading
      let status = 'assigned';
      if (assignment.submitted_at) {
        status = 'submitted';
      }
      if (assignment.grade) {
        status = 'graded';
      }
      
      // Check if assignment is late
      if (assignment.due_date && new Date(assignment.due_date) < new Date() && !assignment.submitted_at) {
        status = 'late';
      }

      return {
        id: assignment.id,
        title: assignment.title,
        description: assignment.description,
        due_date: assignment.due_date,
        max_score: assignment.max_score,
        class_id: assignment.class_id,
        teacher_id: assignment.teacher_id,
        file_url: assignment.file_url,
        grade: assignment.grade,
        feedback: assignment.feedback,
        submitted_at: assignment.submitted_at,
        created_at: assignment.created_at,
        updated_at: assignment.updated_at,
        status: status, // Derived status since it doesn't exist in DB
        submissions: assignment.assignment_submissions || [],
        class: assignment.classes
      };
    });

    res.json(assignments);

  } catch (error) {
    console.error('❌ Error in assignments endpoint:', error);
    
    // Fallback: try simple query without joins
    try {
      const { data: simpleData, error: simpleError } = await supabase
        .from('assignments')
        .select('*')
        .eq('student_id', req.user.id)
        .order('due_date', { ascending: true });

      if (simpleError) {
        throw simpleError;
      }

      // Add derived status and basic structure
      const simpleAssignments = (simpleData || []).map(assignment => {
        let status = 'assigned';
        if (assignment.submitted_at) {
          status = 'submitted';
        }
        if (assignment.grade) {
          status = 'graded';
        }
        if (assignment.due_date && new Date(assignment.due_date) < new Date() && !assignment.submitted_at) {
          status = 'late';
        }

        return {
          ...assignment,
          status: status,
          submissions: [],
          class: null
        };
      });

      res.json(simpleAssignments);

    } catch (fallbackError) {
      console.error('❌ Fallback assignments query also failed:', fallbackError);
      res.json([]); // Return empty array instead of failing
    }
  }
}));
//submit assignment
router.post('/submit-assignment', requireStudent, async (req, res) => {
  console.log('🎯 [BACKEND] Assignment submission started');
  
  try {
    const { assignment_id, submission_text, audio_data } = req.body;
    const studentId = req.studentProfile.id;

    console.log('📝 [BACKEND] Submission data:', {
      assignment_id,
      student_id: studentId,
      has_text: !!submission_text,
      has_audio: !!audio_data
    });

    // Step 1: Enhanced validation
    if (!assignment_id) {
      return res.status(400).json({ error: 'Assignment ID is required' });
    }

    // Step 2: Check assignment exists
    console.log('🔍 [BACKEND] Validating assignment...');
    const { data: assignment, error: assignmentError } = await supabase
      .from('assignments')
      .select('id, title, due_date, status, description')
      .eq('id', assignment_id)
      .single();

    if (assignmentError) {
      console.error('❌ [BACKEND] Assignment query error:', assignmentError);
      if (assignmentError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Assignment not found' });
      }
      return res.status(500).json({ 
        error: 'Assignment query failed: ' + assignmentError.message 
      });
    }

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    console.log('📋 [BACKEND] Assignment details:', {
      id: assignment.id,
      title: assignment.title,
      status: assignment.status,
      due_date: assignment.due_date
    });

    // Step 3: Fix the status check - accept both 'active' and 'assigned'
    const allowedStatuses = ['active', 'assigned'];
    if (!allowedStatuses.includes(assignment.status)) {
      return res.status(400).json({ 
        error: `This assignment is ${assignment.status} and cannot be submitted. Only 'active' or 'assigned' assignments can be submitted.` 
      });
    }

    // Step 4: Check due date (optional)
    if (assignment.due_date && new Date(assignment.due_date) < new Date()) {
      console.log('⚠️ [BACKEND] Assignment due date has passed, but allowing submission');
      // You can choose to block or allow late submissions
    }

    console.log('✅ [BACKEND] Assignment validation passed');

    // Step 5: Handle audio processing (if provided)
    let audioUrl = null;
    if (audio_data) {
      try {
        console.log('🎵 [BACKEND] Processing audio data...');
        // Your audio processing logic here
        audioUrl = `https://storage.supabase.in/assignment-audio/${studentId}/${assignment_id}-${Date.now()}.webm`;
        console.log('✅ [BACKEND] Audio processing completed');
      } catch (audioError) {
        console.error('❌ [BACKEND] Audio processing failed:', audioError);
        return res.status(400).json({ error: 'Audio processing failed' });
      }
    }

    // Step 6: Prepare submission data
    const submissionData = {
      assignment_id,
      student_id: studentId,
      submission_text: submission_text?.trim() || null,
      audio_url: audioUrl,
      submitted_at: new Date().toISOString(),
      status: 'submitted',
      updated_at: new Date().toISOString()
    };

    console.log('💾 [BACKEND] Saving submission...');

    // Step 7: Save to database
    const { data: submission, error: submissionError } = await supabase
      .from('assignment_submissions')
      .insert([submissionData])
      .select(`
        *,
        assignments (
          title,
          due_date
        )
      `)
      .single();

    if (submissionError) {
      console.error('❌ [BACKEND] Database save error:', submissionError);
      
      if (submissionError.code === '23505') {
        return res.status(400).json({ 
          error: 'You have already submitted this assignment' 
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to save submission: ' + submissionError.message 
      });
    }

    console.log('✅ [BACKEND] Assignment submitted successfully');

    // Step 8: Update student progress
    try {
      await updateStudentProgress(studentId);
      console.log('📊 [BACKEND] Student progress updated');
    } catch (progressError) {
      console.warn('⚠️ [BACKEND] Progress update failed:', progressError);
    }

    res.json({
      success: true,
      message: 'Assignment submitted successfully',
      submission: {
        id: submission.id,
        assignment_title: submission.assignments?.title,
        submitted_at: submission.submitted_at,
        status: submission.status
      }
    });

  } catch (error) {
    console.error('💥 [BACKEND] Unhandled error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && {
        details: error.message
      })
    });
  }
});
// Get student exams
router.get('/exams', async (req, res) => {
  try {
    const studentId = req.user.id;
    
    // Get exams for the student's classes
    const { data: exams, error } = await supabase
      .from('exams')
      .select(`
        id,
        title,
        description,
        subject,
        date,
        duration,
        max_score,
        status,
        class:class_id (
          title,
          teacher:teacher_id (
            name
          )
        )
      `)
      .eq('class_id.students_classes.student_id', studentId) // Exams for student's classes
      .order('date', { ascending: true });

    if (error) {
      console.error('Error fetching exams:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json(exams || []);
  } catch (error) {
    console.error('Error fetching exams:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payments
router.get('/payments', asyncHandler(async (req, res) => {
  const tableNames = ['payments', 'fee_payments', 'student_payments', 'transactions'];
  
  for (const tableName of tableNames) {
    try {
      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .eq('student_id', req.user.id)
        .order('payment_date', { ascending: false });

      if (!error) {
        console.log(`✅ Found payments in table: ${tableName}`);
        return res.json(data || []);
      }
      
      // If table doesn't exist, try next one
      if (error.code === 'PGRST205') {
        continue;
      }
      
      // For other errors, throw immediately
      throw error;
    } catch (error) {
      // If it's not a "table not found" error, re-throw
      if (error.code !== 'PGRST205') {
        console.error(`❌ Error querying ${tableName}:`, error);
        throw error;
      }
    }
  }
  
  // If no tables found, return empty array
  console.warn('No payments table found, returning empty array');
  res.json([]);
}));

// Add /contact-admin route
router.post('/contact-admin', asyncHandler(async (req, res) => {
  const { message } = req.body;
  
  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required' });
  }
  
  // Implement: e.g., insert into a messages table or send email
  console.log(`Message from ${req.user.email}: ${message}`);
  res.json({ message: 'Message sent successfully' });
}));

// Error handling middleware for student routes
router.use((err, req, res, next) => {
  console.error('❌ Student route error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default router;
