// routes/teacher.js
// Teacher-specific routes for managing profiles, classes, students, and video sessions.
// All routes are protected by requireAuth and requireTeacher middleware.

import express from 'express';
import { supabase, clearCache, getCache, setCache } from '../server.js';
import { requireAuth, requireTeacher } from '../middleware/auth.js';
import { sanitizeInput } from '../utils/helpers.js';

const router = express.Router();

// Apply authentication middleware to all teacher routes
router.use(requireAuth, requireTeacher);

// Get teacher profile
router.get('/profile', async (req, res) => {
  try {
    console.log('👤 Fetching teacher profile for:', req.user.email);

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, name, email, role, subject, status, created_at, updated_at')
      .eq('id', req.user.id)
      .single();

    if (error) {
      console.error('❌ Error fetching teacher profile:', error);
      return res.status(400).json({ error: 'Error fetching profile' });
    }

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json(profile);
  } catch (error) {
    console.error('❌ Error fetching teacher profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update teacher profile
router.put('/profile', async (req, res) => {
  try {
    const { name, subject } = req.body;

    if (!name && !subject) {
      return res.status(400).json({ error: 'At least one field (name or subject) is required' });
    }

    const updates = {};
    if (name) updates.name = sanitizeInput(name);
    if (subject) updates.subject = sanitizeInput(subject);
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .eq('role', 'teacher')
      .select()
      .single();

    if (error) {
      console.error('❌ Error updating teacher profile:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({
      message: 'Profile updated successfully',
      profile: data
    });
  } catch (error) {
    console.error('❌ Error updating teacher profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get teacher's classes
router.get('/classes', async (req, res) => {
  try {
    const { status, start_date, end_date, page = 1, limit = 50 } = req.query;

    console.log('📚 Fetching classes for teacher:', req.user.id);

    let query = supabase
      .from('classes')
      .select(`
        id,
        title,
        scheduled_date,
        duration,
        max_students,
        description,
        status,
        created_at,
        updated_at,
        students_classes (
          student_id,
          profiles!students_classes_student_id_fkey (
            id,
            name,
            email
          )
        )
      `)
      .eq('teacher_id', req.user.id);

    // Apply filters
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
      console.error('❌ Error fetching classes:', error);
      return res.status(400).json({ error: error.message });
    }

    // Transform data to include student information
    const transformedClasses = classes.map(cls => ({
      ...cls,
      students: cls.students_classes.map(sc => ({
        id: sc.profiles.id,
        name: sc.profiles.name,
        email: sc.profiles.email
      }))
    }));

    res.json({
      classes: transformedClasses,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count
      }
    });
  } catch (error) {
    console.error('❌ Error fetching teacher classes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get teacher's students
router.get('/students', async (req, res) => {
  try {
    console.log('👥 Fetching students for teacher:', req.user.id);

    const cacheKey = `teacher_${req.user.id}_students`;
    const cachedData = getCache(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('id, name, email, course, status, created_at, updated_at')
      .eq('role', 'student')
      .eq('teacher_id', req.user.id)
      .order('name', { ascending: true });

    if (error) {
      console.error('❌ Error fetching students:', error);
      return res.status(400).json({ error: error.message });
    }

    setCache(cacheKey, data || []);

    res.json(data || []);
  } catch (error) {
    console.error('❌ Error fetching teacher students:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

//asignments endpoint
router.post('/assignments', async (req, res) => {
  try {
    const { 
      title, 
      description, 
      due_date, 
      max_score, 
      class_id, 
      student_ids, 
      for_all_students 
    } = req.body;

    if (!title || !due_date) {
      return res.status(400).json({ error: 'Title and due date are required' });
    }

    let targetStudentIds = [];

    if (for_all_students || student_ids === 'all') {
      // For "all students" mode - get ALL students assigned to this teacher
      const { data: teacherStudents, error: studentsError } = await supabase
        .from('profiles')
        .select('id')
        .eq('teacher_id', req.user.id)
        .eq('role', 'student')
        .eq('status', 'active');

      if (studentsError) {
        console.error('Error fetching teacher students:', studentsError);
        return res.status(400).json({ error: 'Error fetching students assigned to teacher' });
      }
      
      targetStudentIds = teacherStudents ? teacherStudents.map(student => student.id) : [];
      
      // If class_id is provided, verify it belongs to teacher (for categorization only)
      if (class_id) {
        const { data: classData, error: classError } = await supabase
          .from('classes')
          .select('id')
          .eq('id', class_id)
          .eq('teacher_id', req.user.id)
          .single();

        if (classError || !classData) {
          return res.status(400).json({ error: 'Class not found or not authorized' });
        }
      }
      
    } else if (Array.isArray(student_ids) && student_ids.length > 0) {
      // For specific students mode - verify students belong to this teacher
      const { data: validStudents, error: studentsError } = await supabase
        .from('profiles')
        .select('id')
        .eq('teacher_id', req.user.id)
        .eq('role', 'student')
        .in('id', student_ids);

      if (studentsError) {
        console.error('Error verifying students:', studentsError);
        return res.status(400).json({ error: 'Error verifying students' });
      }
      
      targetStudentIds = validStudents ? validStudents.map(student => student.id) : [];
      
      // If class_id is provided, verify it belongs to teacher (for categorization only)
      if (class_id) {
        const { data: classData, error: classError } = await supabase
          .from('classes')
          .select('id')
          .eq('id', class_id)
          .eq('teacher_id', req.user.id)
          .single();

        if (classError || !classData) {
          return res.status(400).json({ error: 'Class not found or not authorized' });
        }
      }
    }

    if (targetStudentIds.length === 0) {
      console.log('No valid students found for assignment creation');
      console.log('Teacher ID:', req.user.id);
      console.log('Request data:', req.body);
      
      // Check if teacher has any students assigned
      const { data: teacherStudents, error: checkError } = await supabase
        .from('profiles')
        .select('id')
        .eq('teacher_id', req.user.id)
        .eq('role', 'student')
        .eq('status', 'active');
      
      if (checkError) {
        console.error('Error checking teacher students:', checkError);
      }
      
      const hasStudents = teacherStudents && teacherStudents.length > 0;
      
      return res.status(400).json({ 
        error: hasStudents 
          ? 'No valid students selected for assignment' 
          : 'No students are assigned to you yet. Please contact administration to assign students to your account.'
      });
    }

    // Create assignments for each student
    const assignmentsToCreate = targetStudentIds.map(student_id => ({
      title,
      description,
      due_date,
      max_score: max_score || 100,
      class_id: class_id || null, // Optional class categorization
      teacher_id: req.user.id,
      student_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));

    const { data, error } = await supabase
      .from('assignments')
      .insert(assignmentsToCreate)
      .select();

    if (error) {
      console.error('❌ Error creating assignments:', error);
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({
      message: `Assignment created for ${targetStudentIds.length} students`,
      assignments: data
    });

  } catch (error) {
    console.error('❌ Error creating assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Get teacher's assigned assignments
router.get('/assignments', async (req, res) => {
  try {
    const { student_id, class_id, page = 1, limit = 50 } = req.query;
    
    console.log('📝 Fetching assignments for teacher:', req.user.id);

    let query = supabase
      .from('assignments')
      .select(`
        id,
        title,
        description,
        due_date,
        max_score,
        created_at,
        updated_at,
        class_id,
        student_id,
        classes (
          id,
          title
        ),
        profiles:student_id (
          id,
          name,
          email
        )
      `)
      .eq('teacher_id', req.user.id);

    // Apply filters
    if (student_id) query = query.eq('student_id', student_id);
    if (class_id) query = query.eq('class_id', class_id);

    // Pagination
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.order('created_at', { ascending: false })
                 .range(from, to);

    const { data: assignments, error, count } = await query;

    if (error) {
      console.error('❌ Error fetching assignments:', error);
      return res.status(400).json({ error: error.message });
    }

    // Get submission counts for each assignment
    const assignmentIds = assignments.map(a => a.id);
    let submissionCounts = {};
    
    if (assignmentIds.length > 0) {
      const { data: submissions, error: submissionError } = await supabase
        .from('assignment_submissions') // Adjust table name if different
        .select('assignment_id, student_id, submitted_at, score')
        .in('assignment_id', assignmentIds);
      
      if (!submissionError && submissions) {
        // Count submissions per assignment
        submissionCounts = submissions.reduce((acc, submission) => {
          if (!acc[submission.assignment_id]) {
            acc[submission.assignment_id] = {
              total: 0,
              submitted: 0,
              graded: 0
            };
          }
          acc[submission.assignment_id].total++;
          if (submission.submitted_at) acc[submission.assignment_id].submitted++;
          if (submission.score !== null) acc[submission.assignment_id].graded++;
          return acc;
        }, {});
      }
    }

    // Transform data to include class, student, and submission information
    const transformedAssignments = assignments.map(assignment => {
      const submissions = submissionCounts[assignment.id] || { total: 0, submitted: 0, graded: 0 };
      
      return {
        id: assignment.id,
        title: assignment.title,
        description: assignment.description,
        due_date: assignment.due_date,
        max_score: assignment.max_score,
        created_at: assignment.created_at,
        updated_at: assignment.updated_at,
        class: assignment.classes ? {
          id: assignment.classes.id,
          title: assignment.classes.title
        } : null,
        student: assignment.profiles ? {
          id: assignment.profiles.id,
          name: assignment.profiles.name,
          email: assignment.profiles.email
        } : null,
        // Add submission counts
        student_count: 1, // Each assignment is for 1 student in current structure
        submission_count: submissions.submitted,
        graded_count: submissions.graded,
        pending_count: submissions.total - submissions.graded
      };
    });

    res.json(transformedAssignments || []);
  } catch (error) {
    console.error('❌ Error fetching teacher assignments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Grade an assignment submission
router.put('/assignments/:id/grade', async (req, res) => {
  try {
    const { id } = req.params;
    const { score, feedback } = req.body;

    // Verify assignment belongs to teacher and exists
    const { data: assignment, error: assignmentError } = await supabase
      .from('assignments')
      .select('id, teacher_id')
      .eq('id', id)
      .eq('teacher_id', req.user.id)
      .single();

    if (assignmentError || !assignment) {
      return res.status(404).json({ error: 'Assignment not found or not authorized' });
    }

    const { data, error } = await supabase
      .from('assignments')
      .update({
        score: parseInt(score),
        feedback,
        status: 'graded',
        graded_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error grading assignment:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({
      message: 'Assignment graded successfully',
      assignment: data
    });
  } catch (error) {
    console.error('❌ Error grading assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Start video session
router.post('/video-sessions', async (req, res) => {
  try {
    const { class_id, meeting_id, agenda } = req.body;

    if (!class_id || !meeting_id) {
      return res.status(400).json({ error: 'Class ID and meeting ID are required' });
    }

    // Verify class belongs to teacher
    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('id, title')
      .eq('id', class_id)
      .eq('teacher_id', req.user.id)
      .single();

    if (classError || !classData) {
      console.error('❌ Error fetching class:', classError);
      return res.status(400).json({ error: 'Class not found or not authorized' });
    }

    // Create video session
    const { data, error } = await supabase
      .from('video_sessions')
      .insert([
        {
          class_id,
          teacher_id: req.user.id,
          meeting_id,
          agenda,
          status: 'active',
          started_at: new Date().toISOString(),
          channel_name: `channel_${class_id}_${Date.now()}`
        }
      ])
      .select(`
        id,
        meeting_id,
        class_id,
        teacher_id,
        status,
        started_at,
        channel_name,
        agenda,
        classes (
          title
        )
      `)
      .single();

    if (error) {
      console.error('❌ Error creating video session:', error);
      return res.status(400).json({ error: error.message });
    }

    // Clear cache for live sessions
    clearCache('liveSessions');

    res.status(201).json({
      ...data,
      title: data.classes?.title
    });
  } catch (error) {
    console.error('❌ Error starting video session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// End video session
router.post('/video-sessions/:id/end', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify session belongs to teacher
    const { data: session, error: sessionError } = await supabase
      .from('video_sessions')
      .select('id, teacher_id')
      .eq('id', id)
      .eq('teacher_id', req.user.id)
      .single();

    if (sessionError || !session) {
      console.error('❌ Error fetching video session:', sessionError);
      return res.status(400).json({ error: 'Video session not found or not authorized' });
    }

    const { data, error } = await supabase
      .from('video_sessions')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error ending video session:', error);
      return res.status(400).json({ error: error.message });
    }

    // Clear cache
    clearCache('liveSessions');

    res.json({
      message: 'Video session ended successfully',
      session: data
    });
  } catch (error) {
    console.error('❌ Error ending video session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get teacher's video sessions
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
        ended_at,
        channel_name,
        agenda,
        classes (
          title
        )
      `)
      .eq('teacher_id', req.user.id);

    if (status) query = query.eq('status', status);
    if (start_date) query = query.gte('started_at', start_date);
    if (end_date) query = query.lte('started_at', end_date);

    query = query.order('started_at', { ascending: false });

    const { data, error } = await query;

    if (error) {
      console.error('❌ Error fetching video sessions:', error);
      return res.status(400).json({ error: error.message });
    }

    const sessions = data.map(session => ({
      ...session,
      title: session.classes?.title
    }));

    res.json(sessions);
  } catch (error) {
    console.error('❌ Error fetching video sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;