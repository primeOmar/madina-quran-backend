import express from 'express';
import pkg from 'agora-access-token';
const { RtcTokenBuilder, RtcRole } = pkg;
import { supabase, clearCache } from '../server.js';

const router = express.Router();

// Enhanced in-memory storage with auto-cleanup
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
      participants: sessionData.participants || []
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
  
  // Add method to get session by teacher ID
  getSessionByTeacher(teacherId) {
    for (const [meetingId, session] of this.sessions.entries()) {
      if (session.teacher_id === teacherId && session.status === 'active') {
        return session;
      }
    }
    return null;
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

// Generate valid Agora channel name (max 64 chars, only allowed characters)
function generateValidChannelName(classId, userId) {
  // Extract short IDs from UUIDs (first 8 chars)
  const shortClassId = classId.substring(0, 8);
  const shortUserId = userId.substring(0, 8);

  // Create valid channel name: "class_XXXX_YYYY_timestamp"
  const timestamp = Date.now().toString().substring(6); // Last few digits
  const channelName = `class_${shortClassId}_${shortUserId}_${timestamp}`;

  // Ensure it's under 64 characters
  if (channelName.length > 64) {
    return channelName.substring(0, 64);
  }

  console.log('🔧 Generated channel name:', channelName);
  return channelName;
}


//GENERTAE TOKEN
router.post('/generate-token', async (req, res) => {
  try {
    const { channelName, uid, role = 'publisher' } = req.body;

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.json({ token: null }); // Return null token for testing
    }

    const expirationTime = 3600; // 1 hour
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
    res.json({ token: null }); // Fallback to null token
  }
});


// Generate valid meeting ID
function generateValidMeetingId(classId) {
  const shortClassId = classId.substring(0, 8);
  const timestamp = Date.now();
  return `class_${shortClassId}_${timestamp}`;
}

// ==================== VIDEO SESSION MANAGEMENT ====================

// Start video session (Teacher)
router.post('/start-session', async (req, res) => {
  try {
    const { class_id, user_id } = req.body;
    console.log('🎬 START-SESSION REQUEST:', { class_id, user_id });

    // Validate inputs
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

    console.log('🔍 Class lookup:', { classData, classError });

    if (classError || !classData) {
      return res.status(404).json({
        success: false,
        error: 'Class not found'
      });
    }

    // Check if user is the teacher of this class
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

    // ✅ FIXED DATABASE INSERTION (without participant_count):
    console.log('💾 Creating video session in database...');

    const { data: dbSession, error: dbError } = await supabase
      .from('video_sessions')
      .insert([{
        meeting_id: meetingId,
        class_id: class_id,
        teacher_id: user_id,
        channel_name: channelName,
        status: 'active',
        started_at: new Date().toISOString(),
        scheduled_date: new Date().toISOString(),
        agenda: `Live class: ${classData.title}`
        // Removed participant_count since column doesn't exist
      }])
      .select()
      .single();

    if (dbError) {
      console.error('❌ Database insertion failed:', dbError);

      // ✅ TRY FALLBACK INSERTION WITHOUT PROBLEMATIC COLUMNS:
      console.log('🔄 Attempting fallback database insertion...');

      const { data: fallbackSession, error: fallbackError } = await supabase
        .from('video_sessions')
        .insert([{
          meeting_id: meetingId,
          class_id: class_id,
          teacher_id: user_id,
          channel_name: channelName,
          status: 'active',
          started_at: new Date().toISOString()
          // Only include essential columns
        }])
        .select()
        .single();

      if (fallbackError) {
        console.error('❌ Fallback insertion also failed:', fallbackError);
      } else {
        console.log('✅ Fallback database insertion successful');
      }
    } else {
      console.log('✅ Database insertion successful');
    }

    // ✅ UPDATE CLASS STATUS TO ACTIVE:
    console.log('🔄 Updating class status to active...');
    const { error: classUpdateError } = await supabase
      .from('classes')
      .update({ status: 'active' })
      .eq('id', class_id);

    if (classUpdateError) {
      console.error('❌ Class status update failed:', classUpdateError);
    } else {
      console.log('✅ Class status updated to active');
    }

    // ✅ SEND NOTIFICATIONS TO ENROLLED STUDENTS:
    console.log('🔔 Notifying enrolled students...');
    let notifiedStudents = 0;

    try {
      const { data: enrollments, error: enrollmentError } = await supabase
        .from('students_classes')
        .select('student_id')
        .eq('class_id', class_id);

      if (!enrollmentError && enrollments && enrollments.length > 0) {
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
                action_url: `/join-class/${meetingId}`,
                started_at: new Date().toISOString()
              },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }]);

          if (!notifError) {
            notifiedStudents++;
          }
          return notifError;
        });

        await Promise.allSettled(notificationPromises);
        console.log(`✅ Sent notifications to ${notifiedStudents} students`);
      } else {
        console.log('ℹ️ No students enrolled in this class to notify');
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
      participant_count: 1 // Track in memory even if not in DB
    };

    const session = sessionManager.createSession(meetingId, sessionData);

    // Generate Agora token
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.status(500).json({
        success: false,
        error: 'Video service not configured'
      });
    }

    const expirationTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      user_id,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    console.log('✅ SESSION STARTED SUCCESSFULLY:', {
      meetingId,
      channelName,
      channelLength: channelName.length,
      teacher: user_id,
      db_session_created: !!dbSession,
      students_notified: notifiedStudents
    });

    res.json({
      success: true,
      meeting_id: meetingId,
      meetingId: meetingId,
      channel: channelName,
      token,
      app_id: appId,
      appId: appId,
      uid: user_id,
      session: session,
      class_title: classData.title,
      db_session_created: !!dbSession,
      students_notified: notifiedStudents,
      is_memory_session: true
    });

  } catch (error) {
    console.error('❌ Error starting video session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== JOIN SESSION (ENHANCED) ====================

// Join video session (Students & Teachers)
router.post('/join-session', async (req, res) => {
  try {
    const { meeting_id, user_id, user_type = 'teacher', user_name = 'Teacher' } = req.body;
    
    console.log('🔗 TEACHER JOIN-SESSION REQUEST:', { meeting_id, user_id, user_type, user_name });
    
    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required'
      });
    }
    
    // Get session from memory FIRST
    let session = sessionManager.getSession(meeting_id);
    
    console.log('🔍 Session lookup result:', {
      meeting_id,
      sessionFound: !!session,
      sessionStatus: session?.status,
      sessionTeacher: session?.teacher_id
    });
    
    // ✅ CRITICAL FIX: If session not in memory, try to restore from database
    if (!session) {
      console.log('🔄 Session not in memory, checking database...');
      
      const { data: dbSession, error: dbError } = await supabase
      .from('video_sessions')
      .select(`
      *,
      classes (
        title,
        teacher_id
      )
      `)
      .eq('meeting_id', meeting_id)
      .eq('status', 'active')
      .is('ended_at', null)
      .single();
      
      if (dbError || !dbSession) {
        console.log('❌ No active session found in database either');
        const activeSessions = sessionManager.getActiveSessions();
        
        return res.status(404).json({
          success: false,
          error: 'Active session not found',
          debug: {
            requested_meeting_id: meeting_id,
            memory_sessions: activeSessions.map(s => s.meeting_id),
                                    suggestion: 'Teacher needs to start the session first'
          }
        });
      }
      
      // ✅ RESTORE SESSION FROM DATABASE
      console.log('✅ Found session in database, restoring to memory...');
      session = sessionManager.createSession(meeting_id, {
        id: dbSession.id,
        class_id: dbSession.class_id,
        teacher_id: dbSession.teacher_id,
        status: 'active',
        started_at: dbSession.started_at,
        channel_name: dbSession.channel_name,
        class_title: dbSession.classes?.title,
        participants: [dbSession.teacher_id], // Start with teacher
        db_session_id: dbSession.id
      });
      
      console.log('🔄 Session restored from database:', session);
    }
    
    // ✅ TEACHER-ONLY: Verify this is the session owner
    if (session.teacher_id !== user_id) {
      console.log('❌ Teacher authorization failed:', {
        session_teacher: session.teacher_id,
        requesting_teacher: user_id
      });
      
      return res.status(403).json({
        success: false,
        error: 'Not authorized to join this session. Only the session owner can join.'
      });
    }
    
    console.log('✅ Teacher authorization verified');
    
    // Add teacher to participants if not already there
    if (!session.participants.includes(user_id)) {
      session.participants.push(user_id);
      console.log('✅ Added teacher to participants:', user_id);
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
    
    const expirationTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;
    
    // Teacher always gets UID 1
    const agoraUid = 1;
    
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      session.channel_name,
      agoraUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );
    
    console.log('✅ TEACHER JOINED SESSION SUCCESSFULLY:', {
      meeting_id,
      teacher_id: user_id,
      teacher_name: user_name,
      agora_uid: agoraUid,
      channel: session.channel_name,
      participants_count: session.participants.length,
      session_source: session.db_session_id ? 'database_restored' : 'memory'
    });
    
    res.json({
      success: true,
      meeting_id: meeting_id,
      channel: session.channel_name,
      token,
      app_id: appId,
      uid: agoraUid,
      session: {
        id: session.id,
        class_id: session.class_id,
        teacher_id: session.teacher_id,
        status: session.status,
        class_title: session.class_title,
        channel_name: session.channel_name
      },
      user_type: 'teacher',
      is_restored: !!session.db_session_id
    });
    
  } catch (error) {
    console.error('❌ Error in teacher join-session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
}),

// help debug session issues
router.get('/session-recovery/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;
    
    console.log('🔄 Session recovery check:', meetingId);
    
    // Check memory
    const memorySession = sessionManager.getSession(meetingId);
    
    // Check database
    const { data: dbSession, error } = await supabase
    .from('video_sessions')
    .select(`
    *,
    classes (
      title,
      teacher_id
    )
    `)
    .eq('meeting_id', meetingId)
    .single();
    
    const recoveryData = {
      meeting_id: meetingId,
      in_memory: !!memorySession,
      memory_status: memorySession?.status,
      memory_teacher: memorySession?.teacher_id,
      in_database: !!dbSession,
      db_status: dbSession?.status,
      db_teacher: dbSession?.teacher_id,
      db_channel: dbSession?.channel_name,
      db_started: dbSession?.started_at,
      class_title: dbSession?.classes?.title
    };
    
    console.log('📊 Session recovery data:', recoveryData);
    
    // If found in database but not memory, restore it
    if (dbSession && !memorySession && dbSession.status === 'active') {
      console.log('🔄 Restoring session from database to memory...');
      const restoredSession = sessionManager.createSession(meetingId, {
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
      
      recoveryData.restored_session = restoredSession;
      recoveryData.restored = true;
    }
    
    res.json({
      success: true,
      ...recoveryData
    });
    
  } catch (error) {
    console.error('❌ Session recovery error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// End video session (Teacher only)
router.post('/end-session', async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;

    console.log('🛑 END-SESSION REQUEST:', { meeting_id, user_id });

    if (!meeting_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID is required'
      });
    }

    const session = sessionManager.getSession(meeting_id);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    if (session.teacher_id !== user_id) {
      return res.status(403).json({
        success: false,
        error: 'Only the teacher can end this session'
      });
    }

    // ✅ UPDATE DATABASE SESSION STATUS:
    console.log('💾 Updating video session in database...');

    const { error: dbError } = await supabase
      .from('video_sessions')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('meeting_id', meeting_id)
      .eq('teacher_id', user_id);

    if (dbError) {
      console.error('❌ Database update failed:', dbError);
    }

    // ✅ UPDATE CLASS STATUS BACK TO SCHEDULED:
    console.log('🔄 Updating class status to scheduled...');
    await supabase
      .from('classes')
      .update({ status: 'scheduled' })
      .eq('id', session.class_id);

    sessionManager.endSession(meeting_id);

    console.log('✅ SESSION ENDED:', meeting_id);

    res.json({
      success: true,
      message: 'Session ended successfully',
      session: session,
      db_updated: !dbError,
      is_memory_session: true
    });

  } catch (error) {
    console.error('❌ Error ending video session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== DEBUG & MONITORING ====================

// Get active sessions
router.get('/active-sessions', async (req, res) => {
  try {
    // ✅ COMBINE MEMORY SESSIONS WITH DATABASE SESSIONS:

    // 1. Get sessions from memory (for real-time active sessions)
    const memorySessions = sessionManager.getActiveSessions();

    // 2. Get sessions from database (for persistence)
    const { data: dbSessions, error } = await supabase
      .from('video_sessions')
      .select(`
        *,
        class:classes (title, teacher_id, description),
        teacher:profiles (name, email)
      `)
      .eq('status', 'active')
      .order('started_at', { ascending: false });

    // Combine both sources, prioritizing memory sessions
    const allSessions = [
      ...memorySessions,
      ...(dbSessions || []).map(session => ({
        ...session,
        is_db_session: true,
        participants: session.participants || []
      }))
    ];

    console.log('📊 Combined active sessions:', {
      memory: memorySessions.length,
      database: dbSessions?.length || 0
    });

    res.json({
      success: true,
      sessions: allSessions,
      total_count: allSessions.length,
      memory_sessions: memorySessions.length,
      database_sessions: dbSessions?.length || 0
    });

  } catch (error) {
    console.error('❌ Error fetching active sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});
// Debug endpoint to see all sessions
router.get('/debug-sessions', (req, res) => {
  const sessions = Array.from(sessionManager.sessions.entries()).map(([id, session]) => ({
    meeting_id: id,
    ...session,
    participants_count: session.participants?.length || 0,
    channel_length: session.channel_name?.length || 0
  }));

  res.json({
    all_sessions: sessions,
    total_sessions: sessions.length,
    active_sessions: sessions.filter(s => s.status === 'active').length,
    timestamp: new Date().toISOString()
  });
});
// ==================== video student ENDPOINTS ====================

// Get session status
router.get('/session-status/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;

    console.log('🔍 Checking session status:', meetingId);

    // Get session from memory
    const session = sessionManager.getSession(meetingId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
        is_active: false,
        is_teacher_joined: false,
        student_count: 0
      });
    }

    // Check if teacher has joined (teacher is always first participant)
    const isTeacherJoined = session.participants &&
                           session.participants.includes(session.teacher_id);

    // Count students (excluding teacher)
    const studentCount = session.participants ?
                        session.participants.filter(id => id !== session.teacher_id).length : 0;

    console.log('✅ Session status:', {
      meetingId,
      is_active: session.status === 'active',
      is_teacher_joined: isTeacherJoined,
      student_count: studentCount,
      total_participants: session.participants?.length || 0
    });

    res.json({
      success: true,
      is_active: session.status === 'active',
      is_teacher_joined: isTeacherJoined,
      student_count: studentCount,
      total_participants: session.participants?.length || 0,
      started_at: session.started_at,
      teacher_id: session.teacher_id,
      class_title: session.class_title
    });

  } catch (error) {
    console.error('❌ Error checking session status:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      is_active: false,
      is_teacher_joined: false,
      student_count: 0
    });
  }
});

// Leave video session (CRITICAL - frontend depends on this)
router.post('/leave-session', async (req, res) => {
  try {
    const { meeting_id, user_id, duration = 0, user_type = 'student' } = req.body;

    console.log('🚪 LEAVE-SESSION REQUEST:', { meeting_id, user_id, duration, user_type });

    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required'
      });
    }

    const session = sessionManager.getSession(meeting_id);

    if (!session) {
      console.log('⚠️ Session not found in memory, but allowing leave anyway');
      return res.json({
        success: true,
        message: 'Session left (session not found)'
      });
    }

    // Remove user from participants
    if (session.participants && session.participants.includes(user_id)) {
      session.participants = session.participants.filter(id => id !== user_id);
      console.log('✅ Removed user from participants:', user_id);
    }

    // Record leave in database if possible
    try {
      const { data: dbSession } = await supabase
        .from('video_sessions')
        .select('id')
        .eq('meeting_id', meeting_id)
        .single();

      if (dbSession) {
        await supabase
          .from('video_session_participants')
          .update({
            status: 'left',
            left_at: new Date().toISOString(),
            duration_minutes: Math.round(duration / 60)
          })
          .eq('session_id', dbSession.id)
          .eq('student_id', user_id)
          .is('left_at', null);

        console.log('✅ Recorded leave in database');
      }
    } catch (dbError) {
      console.warn('⚠️ Could not record leave in database:', dbError.message);
    }

    console.log('✅ USER LEFT SESSION:', {
      meeting_id,
      user_id,
      remaining_participants: session.participants?.length || 0
    });

    res.json({
      success: true,
      message: 'Successfully left video session',
      remaining_participants: session.participants?.length || 0
    });

  } catch (error) {
    console.error('❌ Error leaving video session:', error);
    // Always return success for leave operations
    res.json({
      success: true,
      message: 'Left session (with errors)'
    });
  }
});



// Get session info (useful for debugging)
router.get('/session-info/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;

    const session = sessionManager.getSession(meetingId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    res.json({
      success: true,
      session: {
        ...session,
        participants_count: session.participants?.length || 0,
        channel_valid: session.channel_name && session.channel_name.length <= 64
      }
    });

  } catch (error) {
    console.error('❌ Error getting session info:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});
// Health check
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

export default router;
