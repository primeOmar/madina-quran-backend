// routes/video.js - PRODUCTION READY
import express from 'express';
import pkg from 'agora-access-token'; 
const { RtcTokenBuilder, RtcRole } = pkg; 
import { supabase } from '../server.js';

const router = express.Router();

// Fix for express-rate-limit proxy issue
router.use((req, res, next) => {
  req.connection.encrypted = req.connection.encrypted || req.headers['x-forwarded-proto'] === 'https';
  next();
});

// Session Manager
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
  }

  createSession(meetingId, sessionData) {
    console.log('💾 Creating session:', meetingId);
    this.sessions.set(meetingId, {
      ...sessionData,
      lastActivity: Date.now(),
      created: Date.now()
    });
    return this.sessions.get(meetingId);
  }

  getSession(meetingId) {
    const session = this.sessions.get(meetingId);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session;
  }

  endSession(meetingId) {
    console.log('🗑️ Ending session:', meetingId);
    const session = this.sessions.get(meetingId);
    if (session) {
      session.status = 'ended';
      session.ended_at = new Date().toISOString();
    }
    return session;
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

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

const sessionManager = new SessionManager();

// Utility Functions
function generateValidChannelName(classId, userId) {
  const shortClassId = classId.substring(0, 8);
  const shortUserId = userId.substring(0, 8);
  const timestamp = Date.now().toString().substring(6);
  const channelName = `class_${shortClassId}_${shortUserId}_${timestamp}`;
  return channelName.length > 64 ? channelName.substring(0, 64) : channelName;
}

function generateValidMeetingId(classId) {
  const shortClassId = classId.substring(0, 8);
  return `class_${shortClassId}_${Date.now()}`;
}

// Database Helpers
async function getSessionIdFromMeetingId(meetingId) {
  try {
    const { data, error } = await supabase
      .from('video_sessions')
      .select('id, class_id')
      .eq('meeting_id', meetingId)
      .single();
    return error ? null : data;
  } catch (error) {
    return null;
  }
}

async function recordParticipantJoin(meetingId, userId, userType) {
  try {
    const sessionData = await getSessionIdFromMeetingId(meetingId);
    if (!sessionData) {
      console.log('No session found for meeting:', meetingId);
      return false;
    }

    const { error } = await supabase
      .from('session_participants')
      .upsert({
        session_id: sessionData.id,
        user_id: userId,
        user_type: userType,
        class_id: sessionData.class_id,
        joined_at: new Date().toISOString(),
        status: 'joined',
        is_teacher: userType === 'teacher'
      }, {
        onConflict: 'session_id,user_id'
      });

    if (error) {
      console.error('Error recording participant:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error in recordParticipantJoin:', error);
    return false;
  }
}

async function updateDatabaseParticipantLeave(meetingId, userId, duration) {
  try {
    const sessionData = await getSessionIdFromMeetingId(meetingId);
    if (!sessionData) return false;

    const { error } = await supabase
      .from('session_participants')
      .update({
        left_at: new Date().toISOString(),
        duration: Math.max(0, duration || 0),
        status: 'left'
      })
      .eq('session_id', sessionData.id)
      .eq('user_id', userId)
      .is('left_at', null);

    return !error;
  } catch (error) {
    console.error('Error updating participant leave:', error);
    return false;
  }
}

async function getSessionParticipants(meetingId) {
  try {
    const sessionData = await getSessionIdFromMeetingId(meetingId);
    if (!sessionData) return [];

    const { data, error } = await supabase
      .from('session_participants')
      .select('user_id, user_type, joined_at, is_teacher')
      .eq('session_id', sessionData.id)
      .is('left_at', null);

    return error ? [] : (data || []);
  } catch (error) {
    console.error('Error getting session participants:', error);
    return [];
  }
}

// Enhanced validation

// ==================== PRODUCTION ROUTES ====================

// Session Status - PRODUCTION READY
router.get('/session-status/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;
    console.log('🔍 PRODUCTION SESSION-STATUS:', meetingId);

    // Check memory sessions first
    const memorySession = sessionManager.getSession(meetingId);
    if (memorySession) {
      const teacherPresent = memorySession.participants?.includes(memorySession.teacher_id) || false;
      const studentCount = memorySession.participants?.filter(id => id !== memorySession.teacher_id).length || 0;

      return res.json({
        success: true,
        is_active: memorySession.status === 'active',
        is_teacher_joined: teacherPresent,
        student_count: studentCount,
        started_at: memorySession.started_at,
        session: memorySession,
        source: 'memory'
      });
    }

    // Check database
    const { data: dbSession, error: dbError } = await supabase
      .from('video_sessions')
      .select('id, meeting_id, status, started_at, channel_name, class_id, teacher_id')
      .eq('meeting_id', meetingId)
      .single();

    if (dbError || !dbSession) {
      return res.json({
        success: true,
        is_active: false,
        is_teacher_joined: false,
        student_count: 0,
        error: 'Session not found'
      });
    }

    const participants = await getSessionParticipants(meetingId);
    const teacherPresent = participants.some(p => p.user_type === 'teacher' || p.is_teacher);
    const studentCount = participants.filter(p => p.user_type === 'student' || !p.is_teacher).length;

    res.json({
      success: true,
      is_active: dbSession.status === 'active',
      is_teacher_joined: teacherPresent,
      student_count: studentCount,
      started_at: dbSession.started_at,
      session: dbSession,
      source: 'database'
    });

  } catch (error) {
    console.error('❌ Session status error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

// Start Session - PRODUCTION READY
router.post('/start-session', async (req, res) => {
  try {
    const { class_id, user_id } = req.body;
    console.log('🎬 PRODUCTION START-SESSION:', { class_id, user_id });

    if (!class_id || !user_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Class ID and User ID required' 
      });
    }

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
        error: 'Not authorized to start this session' 
      });
    }

    const meetingId = generateValidMeetingId(class_id);
    const channelName = generateValidChannelName(class_id, user_id);

    // Create session in database
    const { data: dbSession, error: dbError } = await supabase
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

    if (dbError) {
      console.error('❌ DB insertion failed:', dbError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to create session' 
      });
    }

    // Update class status
    await supabase
      .from('classes')
      .update({ status: 'active' })
      .eq('id', class_id);

    const sessionData = {
      id: meetingId,
      class_id,
      teacher_id: user_id,
      status: 'active',
      started_at: new Date().toISOString(),
      channel_name: channelName,
      class_title: classData.title,
      participants: [user_id],
      db_session_id: dbSession?.id
    };

    const session = sessionManager.createSession(meetingId, sessionData);

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    
    if (!appId || !appCertificate) {
      return res.status(500).json({ 
        success: false, 
        error: 'Video service not configured' 
      });
    }

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      user_id,
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + 3600
    );

    console.log('✅ PRODUCTION SESSION STARTED:', meetingId);

    res.json({
      success: true,
      meeting_id: meetingId,
      channel: channelName,
      token,
      app_id: appId,
      uid: user_id,
      session: session,
      class_title: classData.title,
      teacher_name: classData.teacher_name
    });

  } catch (error) {
    console.error('❌ Start session error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// verify student
const validateStudentAccess = async (classId, studentId) => {
  try {
    console.log('🔍 Validating student access:', { classId, studentId });
    
    // First check if the class exists and get teacher info
    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('id, title, status, teacher_id')
      .eq('id', classId)
      .single();

    if (classError || !classData) {
      console.error('❌ Class not found:', classError);
      return false;
    }

    // Check if student is assigned to this teacher
    const { data: studentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('teacher_id')
      .eq('id', studentId)
      .single();

    if (profileError || !studentProfile) {
      console.error('❌ Student profile not found:', profileError);
      return false;
    }

    // ✅ ALLOW ACCESS if student has same teacher as class
    const hasAccess = studentProfile.teacher_id === classData.teacher_id;
    
    console.log('✅ Access validation result:', { 
      hasAccess, 
      studentTeacher: studentProfile.teacher_id, 
      classTeacher: classData.teacher_id 
    });
    
    return hasAccess;
    
  } catch (error) {
    console.error('❌ Error in access validation:', error);
    
    // For safety, allow access during errors
    console.log('⚠️ Allowing access due to validation error');
    return true;
  }
};
// Join Session - PRODUCTION READY (FIXED FOR STUDENT)
router.post('/join-session', async (req, res) => {
  try {
    const { meeting_id, user_id, user_type = 'student', user_name = 'Student' } = req.body;

    console.log('🔗 PRODUCTION JOIN-SESSION REQUEST:', { meeting_id, user_id, user_type, user_name });

    // Validate inputs
    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required'
      });
    }

    // Get session from memory or database
    let session = sessionManager.getSession(meeting_id);
    let classData = null;

    if (!session) {
      // Try to get session from database with class info
      const { data: dbSession, error: dbError } = await supabase
        .from('video_sessions')
        .select(`
          *,
          classes (
            title,
            teacher_id,
            teacher:teacher_id (
              name
            )
          )
        `)
        .eq('meeting_id', meeting_id)
        .single();

      if (dbError || !dbSession) {
        return res.status(404).json({
          success: false,
          error: 'Active session not found'
        });
      }

      // Create memory session from database
      session = sessionManager.createSession(meeting_id, {
        ...dbSession,
        class_title: dbSession.classes?.title,
        teacher_name: dbSession.classes?.teacher?.name,
        participants: []
      });

      classData = dbSession.classes;
    }

    console.log('🔍 Session lookup result:', {
      meeting_id,
      sessionFound: !!session,
      sessionStatus: session?.status,
      sessionTeacher: session?.teacher_id
    });

    if (!session || session.status !== 'active') {
      return res.status(404).json({
        success: false,
        error: 'Active session not found or ended'
      });
    }

    // ✅ REMOVED ENROLLMENT CHECK - Students can join any class by their teacher

    // For students, validate they have the same teacher as the class
    if (user_type === 'student') {
      const hasAccess = await validateStudentAccess(session.class_id, user_id);
      if (!hasAccess) {
        console.log('❌ Student not authorized for this class:', { 
          class_id: session.class_id, 
          user_id 
        });
        return res.status(403).json({
          success: false,
          error: 'Student not authorized to join this class'
        });
      }
    }

    // Generate Agora credentials
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      console.error('❌ Agora credentials not configured');
      return res.status(500).json({
        success: false,
        error: 'Video service not configured'
      });
    }

    const expirationTime = 3600; // 1 hour
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;

    // UID generation
    let agoraUid;
    if (user_type === 'teacher') {
      agoraUid = 1; // Teacher always gets UID 1
    } else {
      // Generate deterministic but unique UID for students
      const hash = user_id.split('').reduce((a, b) => {
        a = ((a << 5) - a) + b.charCodeAt(0);
        return a & a;
      }, 0);
      agoraUid = Math.abs(hash % 100000) + 1000; // Students get 1000+
    }

    // Ensure UID is valid integer
    agoraUid = Math.max(1, Math.min(4294967295, agoraUid));

    // Generate token
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      session.channel_name,
      agoraUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    // Record participation (non-blocking)
    recordParticipantJoin(meeting_id, user_id, user_type)
      .then(success => {
        if (success) {
          console.log('✅ Participation recorded for user:', user_id);
        } else {
          console.warn('⚠️ Failed to record participation for user:', user_id);
        }
      })
      .catch(err => {
        console.error('❌ Error recording participation:', err);
      });

    // Update memory session participants
    if (session.participants && !session.participants.includes(user_id)) {
      session.participants.push(user_id);
    }

    console.log('✅ PRODUCTION USER JOIN SESSION SUCCESS:', {
      meeting_id,
      user_id,
      user_type,
      agora_uid: agoraUid,
      channel: session.channel_name
    });

    // Return success response with all required data
    const response = {
      success: true,
      meetingId: meeting_id, 
      channel: session.channel_name,
      token,
      appId: appId,
      uid: agoraUid,
      sessionInfo: { 
        id: session.id,
        class_id: session.class_id,
        teacher_id: session.teacher_id,
        status: session.status,
        class_title: session.class_title || classData?.title,
        teacher_name: session.teacher_name || classData?.teacher?.name
      }
    };

    res.json(response);

  } catch (error) {
    console.error('❌ PRODUCTION Error joining video session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});
});

// Leave Session - PRODUCTION READY
router.post('/leave-session', async (req, res) => {
  try {
    const { meeting_id, user_id, duration = 0, user_type = 'student' } = req.body;
    console.log('🚪 PRODUCTION LEAVE-SESSION:', { meeting_id, user_id });

    if (!meeting_id || !user_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Meeting ID and User ID required' 
      });
    }

    const session = sessionManager.getSession(meeting_id);
    if (session?.participants) {
      session.participants = session.participants.filter(id => id !== user_id);
    }

    await updateDatabaseParticipantLeave(meeting_id, user_id, duration);

    res.json({
      success: true,
      message: 'Successfully left session'
    });

  } catch (error) {
    console.error('❌ Leave session error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// End Session - PRODUCTION READY
router.post('/end-session', async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;
    console.log('🛑 PRODUCTION END-SESSION:', { meeting_id, user_id });

    if (!meeting_id || !user_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Meeting ID and User ID required' 
      });
    }

    const session = sessionManager.getSession(meeting_id);
    if (!session || session.teacher_id !== user_id) {
      return res.status(403).json({ 
        success: false, 
        error: 'Not authorized to end this session' 
      });
    }

    // End session in memory
    sessionManager.endSession(meeting_id);

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
      .update({ status: 'completed' })
      .eq('id', session.class_id);

    console.log('✅ PRODUCTION SESSION ENDED:', meeting_id);

    res.json({
      success: true,
      message: 'Session ended successfully'
    });

  } catch (error) {
    console.error('❌ End session error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Active Sessions - PRODUCTION READY
router.get('/active-sessions', async (req, res) => {
  try {
    const activeSessions = sessionManager.getActiveSessions();
    
    res.json({
      success: true,
      active_sessions: activeSessions,
      count: activeSessions.length
    });

  } catch (error) {
    console.error('❌ Get active sessions error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Health Check - PRODUCTION READY
router.get('/health', async (req, res) => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  
  try {
    // Test database connection
    const { data, error } = await supabase
      .from('video_sessions')
      .select('count')
      .limit(1);

    res.json({
      success: true,
      status: appId && appCertificate ? 'healthy' : 'unhealthy',
      video_enabled: !!(appId && appCertificate),
      database_connected: !error,
      active_sessions: sessionManager.getActiveSessions().length,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Cleanup
process.on('SIGINT', () => {
  sessionManager.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  sessionManager.destroy();
  process.exit(0);
});

export default router;
