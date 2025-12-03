import express from 'express';
import pkg from 'agora-access-token';
const { RtcTokenBuilder, RtcRole } = pkg;
import { supabase, clearCache } from '../server.js';

const router = express.Router();

// ==================== ENHANCED SESSION MANAGER ====================
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000); // 5 minutes
  }
  
  createSession(meetingId, sessionData) {
    console.log('💾 Creating session:', meetingId);
    const session = {
      ...sessionData,
      lastActivity: Date.now(),
      created: Date.now(),
      participants: sessionData.participants || [],
      agora_uids: sessionData.agora_uids || {} // Map user_id to agora uid
    };
    
    this.sessions.set(meetingId, session);
    
    console.log('✅ Session created:', {
      meetingId,
      teacher: session.teacher_id,
      channel: session.channel_name,
      participants: session.participants.length
    });
    
    return session;
  }
  
  getSession(meetingId) {
    const session = this.sessions.get(meetingId);
    if (session) {
      session.lastActivity = Date.now();
      console.log('📥 Session retrieved from memory:', meetingId);
    }
    return session;
  }
  
  getSessionByTeacher(teacherId) {
    for (const [meetingId, session] of this.sessions.entries()) {
      if (session.teacher_id === teacherId && session.status === 'active') {
        return { meetingId, session };
      }
    }
    return null;
  }

  endSession(meetingId) {
    console.log('🛑 Ending session in memory:', meetingId);
    const session = this.sessions.get(meetingId);
    if (session) {
      session.status = 'ended';
      session.ended_at = new Date().toISOString();
      console.log('✅ Session ended in memory:', meetingId);
    } else {
      console.warn('⚠️ Session not found in memory for ending:', meetingId);
    }
  }
  
  addParticipant(meetingId, userId, agoraUid) {
    const session = this.sessions.get(meetingId);
    if (session) {
      if (!session.participants.includes(userId)) {
        session.participants.push(userId);
      }
      session.agora_uids[userId] = agoraUid;
      console.log('➕ Added participant:', { meetingId, userId, agoraUid });
      return true;
    }
    return false;
  }
  
  removeParticipant(meetingId, userId) {
    const session = this.sessions.get(meetingId);
    if (session) {
      session.participants = session.participants.filter(id => id !== userId);
      delete session.agora_uids[userId];
      console.log('➖ Removed participant:', { meetingId, userId });
      return true;
    }
    return false;
  }
  
  getParticipantCount(meetingId) {
    const session = this.sessions.get(meetingId);
    return session ? session.participants.length : 0;
  }
  
  isTeacherPresent(meetingId) {
    const session = this.sessions.get(meetingId);
    if (!session) return false;
    return session.participants.includes(session.teacher_id);
  }

  getActiveSessions() {
    const active = [];
    for (const [meetingId, session] of this.sessions.entries()) {
      if (session.status === 'active') {
        active.push({
          ...session,
          meeting_id: meetingId
        });
      }
    }
    return active;
  }
  
  cleanup() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    for (const [meetingId, session] of this.sessions.entries()) {
      if (now - session.created > oneHour || session.status === 'ended') {
        console.log('🧹 Cleaning up old session:', meetingId);
        this.sessions.delete(meetingId);
      }
    }
  }
}

const sessionManager = new SessionManager();

// ==================== UTILITY FUNCTIONS ====================
function generateValidChannelName(classId, userId) {
  const shortClassId = classId.substring(0, 8);
  const shortUserId = userId.substring(0, 8);
  const timestamp = Date.now().toString().substring(6);
  const channelName = `class_${shortClassId}_${shortUserId}_${timestamp}`;
  
  if (channelName.length > 64) {
    return channelName.substring(0, 64);
  }
  
  console.log('🔧 Generated channel name:', channelName);
  return channelName;
}

function generateValidMeetingId(classId) {
  const shortClassId = classId.substring(0, 8);
  const timestamp = Date.now();
  return `class_${shortClassId}_${timestamp}`;
}

// ==================== START SESSION (TEACHER) ====================
router.post('/start-session', async (req, res) => {
  try {
    const { class_id, user_id } = req.body;
    console.log('🎬 START-SESSION REQUEST:', { class_id, user_id });

    if (!class_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Class ID and User ID are required'
      });
    }

    // Verify class exists and teacher is authorized
    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('id, title, teacher_id, status')
      .eq('id', class_id)
      .single();

    if (classError || !classData) {
      return res.status(404).json({
        success: false,
        error: 'Class not found'
      });
    }

    if (classData.teacher_id !== user_id) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to start this class session'
      });
    }

    // Generate valid meeting ID and channel name
    const meetingId = generateValidMeetingId(class_id);
    const channelName = generateValidChannelName(class_id, user_id);

    console.log('📝 Generated valid session details:', { meetingId, channelName });

    // Create video session in database
    const { data: dbSession, error: dbError } = await supabase
      .from('video_sessions')
      .insert([{
        meeting_id: meetingId,
        class_id: class_id,
        teacher_id: user_id,
        channel_name: channelName,
        status: 'active',
        started_at: new Date().toISOString(),
        agenda: `Live class: ${classData.title}`
      }])
      .select()
      .single();

    if (dbError) {
      console.error('❌ Database insertion failed:', dbError);
      // Fallback without agenda
      const { data: fallbackSession, error: fallbackError } = await supabase
        .from('video_sessions')
        .insert([{
          meeting_id: meetingId,
          class_id: class_id,
          teacher_id: user_id,
          channel_name: channelName,
          status: 'active',
          started_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (fallbackError) {
        console.error('❌ Fallback insertion also failed:', fallbackError);
        return res.status(500).json({
          success: false,
          error: 'Failed to create session in database'
        });
      }
    }

    // Update class status to active
    await supabase
      .from('classes')
      .update({ status: 'active' })
      .eq('id', class_id);

    // Send notifications to enrolled students
    let notifiedStudents = 0;
    try {
      const { data: enrollments } = await supabase
        .from('students_classes')
        .select('student_id')
        .eq('class_id', class_id);

      if (enrollments && enrollments.length > 0) {
        const notificationPromises = enrollments.map(async (enrollment) => {
          const { error: notifError } = await supabase
            .from('notifications')
            .insert([{
              user_id: enrollment.student_id,
              title: '🎥 Class Started Live',
              message: `Your class "${classData.title}" has started. Click to join the live session!`,
              type: 'live_class',
              data: {
                class_id: class_id,
                meeting_id: meetingId,
                class_title: classData.title,
                teacher_id: user_id,
                action_url: `/join-class/${meetingId}`
              },
              created_at: new Date().toISOString()
            }]);

          if (!notifError) notifiedStudents++;
        });

        await Promise.allSettled(notificationPromises);
        console.log(`✅ Sent notifications to ${notifiedStudents} students`);
      }
    } catch (notifError) {
      console.error('❌ Notification sending failed:', notifError);
    }

    // Create session in memory
    const sessionData = {
      id: meetingId,
      class_id,
      teacher_id: user_id,
      status: 'active',
      started_at: new Date().toISOString(),
      channel_name: channelName,
      class_title: classData.title,
      participants: [user_id],
      db_session_id: dbSession?.id,
      agora_uids: {}
    };

    sessionManager.createSession(meetingId, sessionData);

    console.log('✅ SESSION STARTED SUCCESSFULLY:', {
      meetingId,
      channelName,
      teacher: user_id,
      students_notified: notifiedStudents
    });

    res.json({
      success: true,
      meeting_id: meetingId,
      channel: channelName,
      app_id: process.env.AGORA_APP_ID,
      teacher_id: user_id,
      class_title: classData.title,
      db_session_created: !!dbSession,
      students_notified: notifiedStudents
    });

  } catch (error) {
    console.error('❌ Error starting video session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== UNIFIED JOIN SESSION (BOTH TEACHER & STUDENT) ====================
router.post('/join-session', async (req, res) => {
  try {
    const { 
      meeting_id, 
      user_id, 
      user_type = 'teacher',
      user_name = '',
      require_enrollment = false
    } = req.body;

    console.log('🔗 JOIN-SESSION REQUEST:', { 
      meeting_id, 
      user_id, 
      user_type,
      user_name 
    });

    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required',
        code: 'MISSING_PARAMS'
      });
    }

    // Clean meeting_id
    const cleanMeetingId = meeting_id.replace(/["']/g, '');
    
    // Get session from memory or database
    let session = sessionManager.getSession(cleanMeetingId);
    
    if (!session) {
      console.log('🔄 Session not in memory, checking database...');
      
      const { data: dbSession, error: dbError } = await supabase
        .from('video_sessions')
        .select(`
          *,
          classes (
            title,
            teacher_id,
            id
          )
        `)
        .eq('meeting_id', cleanMeetingId)
        .eq('status', 'active')
        .single();

      if (dbError || !dbSession) {
        return res.status(404).json({
          success: false,
          error: 'Active session not found. Teacher needs to start the session first.',
          code: 'SESSION_NOT_FOUND'
        });
      }

      // Restore session from database
      session = sessionManager.createSession(cleanMeetingId, {
        id: dbSession.id,
        meeting_id: cleanMeetingId,
        class_id: dbSession.class_id,
        teacher_id: dbSession.teacher_id,
        status: 'active',
        started_at: dbSession.started_at,
        channel_name: dbSession.channel_name,
        class_title: dbSession.classes?.title,
        participants: [],
        db_session_id: dbSession.id,
        agora_uids: {}
      });
    }

    const isTeacher = user_type === 'teacher';
    
    // ========== TEACHER VALIDATION ==========
    if (isTeacher) {
      if (session.teacher_id !== user_id) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to join this session as teacher.',
          code: 'TEACHER_AUTH_FAILED'
        });
      }
    } 
    // ========== STUDENT VALIDATION ==========
    else {
      if (require_enrollment) {
        const { data: enrollment, error: enrollmentError } = await supabase
          .from('students_classes')
          .select('*')
          .eq('class_id', session.class_id)
          .eq('student_id', user_id)
          .single();

        if (enrollmentError || !enrollment) {
          return res.status(403).json({
            success: false,
            error: 'You are not enrolled in this class',
            code: 'NOT_ENROLLED'
          });
        }
      }
    }

    // Check if teacher is present (for students)
    const teacherPresent = sessionManager.isTeacherPresent(cleanMeetingId);
    if (!isTeacher && !teacherPresent) {
      return res.status(400).json({
        success: false,
        error: 'Teacher has not joined the session yet. Please wait for teacher to start.',
        code: 'TEACHER_NOT_JOINED',
        canRetry: true
      });
    }

    // ========== TOKEN GENERATION ==========
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.status(500).json({
        success: false,
        error: 'Video service not configured',
        code: 'AGORA_CONFIG_MISSING'
      });
    }

    // Generate Agora UID
    let agoraUid;
    if (isTeacher) {
      agoraUid = 1; // Teacher always gets UID 1
    } else {
      // Generate unique UID for student (not 1)
      do {
        agoraUid = Math.floor(Math.random() * 100000) + 1000; // 1000-100999
      } while (agoraUid === 1 || Object.values(session.agora_uids || {}).includes(agoraUid));
    }

    const expirationTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      session.channel_name,
      agoraUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    // Add participant to session
    sessionManager.addParticipant(cleanMeetingId, user_id, agoraUid);

    // Log participant in database
    try {
      await supabase
        .from('session_participants')
        .upsert({
          session_id: session.db_session_id || session.id,
          user_id: user_id,
          role: isTeacher ? 'teacher' : 'student',
          status: 'joined',
          joined_at: new Date().toISOString(),
          agora_uid: agoraUid
        }, {
          onConflict: 'session_id,user_id'
        });
    } catch (dbError) {
      console.warn('⚠️ Database logging failed:', dbError.message);
    }

    // ========== BUILD RESPONSE ==========
    const response = {
      success: true,
      meeting_id: cleanMeetingId,
      channel: session.channel_name,
      token,
      app_id: appId,
      uid: agoraUid,
      user_type: isTeacher ? 'teacher' : 'student',
      is_teacher: isTeacher,
      teacher_present: teacherPresent,
      session: {
        id: session.id,
        meeting_id: cleanMeetingId,
        class_id: session.class_id,
        teacher_id: session.teacher_id,
        status: session.status,
        class_title: session.class_title,
        channel_name: session.channel_name,
        participants_count: sessionManager.getParticipantCount(cleanMeetingId)
      }
    };

    // Add enrollment status for students
    if (!isTeacher) {
      try {
        const { data: enrollment } = await supabase
          .from('students_classes')
          .select('*')
          .eq('class_id', session.class_id)
          .eq('student_id', user_id)
          .single();
        
        response.enrolled = !!enrollment;
      } catch (e) {
        response.enrolled = false;
      }
    }

    console.log('✅ JOIN SUCCESSFUL:', {
      meeting_id: cleanMeetingId,
      user_id,
      user_type,
      agora_uid: agoraUid,
      teacher_present: teacherPresent
    });

    res.json(response);

  } catch (error) {
    console.error('❌ Error in join-session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

// ==================== END SESSION (TEACHER ONLY) ====================
router.post('/end-session', async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;

    console.log('🛑 END-SESSION REQUEST:', { meeting_id, user_id });

    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required'
      });
    }

    const session = sessionManager.getSession(meeting_id);

    if (!session) {
      // Try to find session in database
      const { data: dbSession } = await supabase
        .from('video_sessions')
        .select('*, classes(title, teacher_id)')
        .eq('meeting_id', meeting_id)
        .single();

      if (!dbSession) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      if (dbSession.teacher_id !== user_id) {
        return res.status(403).json({
          success: false,
          error: 'Only the teacher can end this session'
        });
      }

      // Update database
      await supabase
        .from('video_sessions')
        .update({
          status: 'ended',
          ended_at: new Date().toISOString()
        })
        .eq('meeting_id', meeting_id);

      // Update class status
      await supabase
        .from('classes')
        .update({ status: 'finished' })
        .eq('id', dbSession.class_id);

      return res.json({
        success: true,
        message: 'Session ended successfully'
      });
    }

    // Check authorization
    if (session.teacher_id !== user_id) {
      return res.status(403).json({
        success: false,
        error: 'Only the teacher can end this session'
      });
    }

    // Update database
    await supabase
      .from('video_sessions')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString()
      })
      .eq('meeting_id', meeting_id);

    // Update class status
    await supabase
      .from('classes')
      .update({ status: 'finished' })
      .eq('id', session.class_id);

    // End session in memory
    sessionManager.endSession(meeting_id);

    console.log('✅ SESSION ENDED:', meeting_id);

    res.json({
      success: true,
      message: 'Session ended successfully',
      session: session
    });

  } catch (error) {
    console.error('❌ Error ending video session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== LEAVE SESSION ====================
router.post('/leave-session', async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;

    console.log('🚪 LEAVE-SESSION REQUEST:', { meeting_id, user_id });

    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required'
      });
    }

    const session = sessionManager.getSession(meeting_id);
    const isTeacher = session && session.teacher_id === user_id;

    // Remove from memory
    if (session) {
      sessionManager.removeParticipant(meeting_id, user_id);
    }

    // Update database status
    if (isTeacher) {
      // If teacher leaves, end the session
      await supabase
        .from('video_sessions')
        .update({
          status: 'ended',
          ended_at: new Date().toISOString()
        })
        .eq('meeting_id', meeting_id);
    } else {
      // Update participant status to left
      try {
        await supabase
          .from('session_participants')
          .update({
            status: 'left',
            left_at: new Date().toISOString()
          })
          .eq('session_id', session?.db_session_id)
          .eq('user_id', user_id);
      } catch (error) {
        console.warn('⚠️ Could not update participant status:', error.message);
      }
    }

    console.log('✅ USER LEFT SESSION:', {
      meeting_id,
      user_id,
      isTeacher
    });

    res.json({
      success: true,
      message: 'Successfully left video session',
      isTeacher: isTeacher,
      sessionEnded: isTeacher
    });

  } catch (error) {
    console.error('❌ Error leaving video session:', error);
    res.json({
      success: true,
      message: 'Left session'
    });
  }
});

// ==================== SESSION STATUS & INFO ====================
router.get('/session-status/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;
    const session = sessionManager.getSession(meetingId);

    if (!session) {
      return res.json({
        success: true,
        exists: false,
        is_active: false,
        is_teacher_joined: false,
        participant_count: 0
      });
    }

    const teacherJoined = sessionManager.isTeacherPresent(meetingId);
    const studentCount = sessionManager.getParticipantCount(meetingId) - (teacherJoined ? 1 : 0);

    res.json({
      success: true,
      exists: true,
      is_active: session.status === 'active',
      is_teacher_joined: teacherJoined,
      teacher_id: session.teacher_id,
      student_count: studentCount,
      total_participants: sessionManager.getParticipantCount(meetingId),
      started_at: session.started_at,
      class_title: session.class_title,
      channel_name: session.channel_name
    });

  } catch (error) {
    console.error('❌ Error checking session status:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

router.get('/session-by-class/:classId', async (req, res) => {
  try {
    const { classId } = req.params;
    
    // Check memory sessions
    const memorySessions = sessionManager.getActiveSessions();
    const memorySession = memorySessions.find(s => s.class_id === classId);
    
    if (memorySession) {
      return res.json({
        success: true,
        session: {
          meeting_id: memorySession.meeting_id,
          class_id: memorySession.class_id,
          teacher_id: memorySession.teacher_id,
          status: memorySession.status,
          channel_name: memorySession.channel_name,
          started_at: memorySession.started_at,
          class_title: memorySession.class_title,
          participants: memorySession.participants || []
        },
        exists: true,
        isActive: true
      });
    }

    // Check database
    const { data: dbSession } = await supabase
      .from('video_sessions')
      .select(`
        *,
        classes (
          title,
          teacher_id
        )
      `)
      .eq('class_id', classId)
      .eq('status', 'active')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .single();

    if (!dbSession) {
      return res.json({
        success: true,
        exists: false,
        isActive: false,
        error: 'No active session found for this class'
      });
    }

    // Restore to memory
    sessionManager.createSession(dbSession.meeting_id, {
      id: dbSession.id,
      class_id: dbSession.class_id,
      teacher_id: dbSession.teacher_id,
      status: 'active',
      started_at: dbSession.started_at,
      channel_name: dbSession.channel_name,
      class_title: dbSession.classes?.title,
      participants: [dbSession.teacher_id],
      db_session_id: dbSession.id
    });

    res.json({
      success: true,
      session: {
        meeting_id: dbSession.meeting_id,
        class_id: dbSession.class_id,
        teacher_id: dbSession.teacher_id,
        status: dbSession.status,
        channel_name: dbSession.channel_name,
        started_at: dbSession.started_at,
        class_title: dbSession.classes?.title,
        participants: [dbSession.teacher_id]
      },
      exists: true,
      isActive: true,
      restored: true
    });

  } catch (error) {
    console.error('❌ Error finding session by class:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== VALIDATE STUDENT JOIN ====================
router.post('/validate-student-join', async (req, res) => {
  try {
    const { class_id, student_id, meeting_id } = req.body;

    console.log('🔐 Validating student join:', { class_id, student_id, meeting_id });

    if (!class_id || !student_id) {
      return res.status(400).json({
        success: false,
        error: 'Class ID and Student ID are required',
        code: 'MISSING_PARAMS'
      });
    }

    // Check enrollment
    const { data: enrollment } = await supabase
      .from('students_classes')
      .select('*')
      .eq('class_id', class_id)
      .eq('student_id', student_id)
      .single();

    if (!enrollment) {
      return res.status(403).json({
        success: false,
        error: 'You are not enrolled in this class',
        code: 'NOT_ENROLLED'
      });
    }

    // Find session
    let session = null;
    if (meeting_id) {
      session = sessionManager.getSession(meeting_id);
    } else {
      // Find session by class
      const { data: dbSession } = await supabase
        .from('video_sessions')
        .select('*')
        .eq('class_id', class_id)
        .eq('status', 'active')
        .is('ended_at', null)
        .single();
      
      if (dbSession) {
        session = {
          meeting_id: dbSession.meeting_id,
          class_id: dbSession.class_id,
          teacher_id: dbSession.teacher_id,
          status: dbSession.status,
          channel_name: dbSession.channel_name
        };
      }
    }

    if (!session) {
      return res.json({
        success: false,
        error: 'No active session found for this class',
        code: 'NO_ACTIVE_SESSION',
        canJoin: false
      });
    }

    const teacherPresent = sessionManager.isTeacherPresent(session.meeting_id);

    res.json({
      success: true,
      canJoin: true,
      meetingId: session.meeting_id,
      channel: session.channel_name,
      teacher_present: teacherPresent,
      validation: {
        enrolled: true,
        session_active: true,
        teacher_present: teacherPresent
      }
    });

  } catch (error) {
    console.error('❌ Error validating student join:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      canJoin: false
    });
  }
});

// ==================== DEBUG & UTILITY ENDPOINTS ====================
router.get('/active-sessions', async (req, res) => {
  try {
    const memorySessions = sessionManager.getActiveSessions();
    const { data: dbSessions } = await supabase
      .from('video_sessions')
      .select(`
        *,
        classes (title, teacher_id, description)
      `)
      .eq('status', 'active')
      .order('started_at', { ascending: false });

    res.json({
      success: true,
      memory_sessions: memorySessions,
      database_sessions: dbSessions || [],
      memory_count: memorySessions.length,
      database_count: dbSessions?.length || 0
    });

  } catch (error) {
    console.error('❌ Error fetching active sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

router.get('/debug-sessions', (req, res) => {
  const sessions = Array.from(sessionManager.sessions.entries()).map(([id, session]) => ({
    meeting_id: id,
    ...session,
    participants_count: session.participants?.length || 0
  }));

  res.json({
    all_sessions: sessions,
    total_sessions: sessions.length,
    active_sessions: sessions.filter(s => s.status === 'active').length
  });
});

router.get('/health', (req, res) => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  const hasAppId = !!(appId && appId !== '""' && appId !== "''");
  const hasCertificate = !!(appCertificate && appCertificate !== '""' && appCertificate !== "''");

  const activeSessions = sessionManager.getActiveSessions();

  res.json({
    status: hasAppId && hasCertificate ? 'healthy' : 'unhealthy',
    videoEnabled: hasAppId && hasCertificate,
    appIdConfigured: hasAppId,
    appCertificateConfigured: hasCertificate,
    activeSessions: activeSessions.length,
    totalSessions: sessionManager.sessions.size,
    timestamp: new Date().toISOString()
  });
});

// ==================== TOKEN GENERATION ENDPOINT ====================
router.post('/generate-token', async (req, res) => {
  try {
    const { channelName, uid, role = 'publisher' } = req.body;

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.json({ token: null });
    }

    const expirationTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
      privilegeExpiredTs
    );

    res.json({ token, appId, channelName, uid });
  } catch (error) {
    console.error('Token generation error:', error);
    res.json({ token: null });
  }
});

export default router;
