import express from 'express';
import pkg from 'agora-access-token'; 
const { RtcTokenBuilder, RtcRole } = pkg; 
import { supabase, clearCache } from '../server.js';

const router = express.Router();

// Enhanced in-memory storage with auto-cleanup
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

    // ✅ ADD DATABASE INSERTION HERE:
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
        agenda: `Live class: ${classData.title}`,
        participant_count: 1
      }])
      .select()
      .single();

    if (dbError) {
      console.error('❌ Database insertion failed:', dbError);
      // Don't fail the entire request, but log the error
      // Continue with in-memory session as fallback
    }

    // ✅ UPDATE CLASS STATUS TO ACTIVE:
    console.log('🔄 Updating class status to active...');
    const { error: classUpdateError } = await supabase
      .from('classes')
      .update({ status: 'active' })
      .eq('id', class_id);

    if (classUpdateError) {
      console.error('❌ Class status update failed:', classUpdateError);
    }

    // ✅ SEND NOTIFICATIONS TO ENROLLED STUDENTS:
    console.log('🔔 Notifying enrolled students...');
    try {
      const { data: enrollments, error: enrollmentError } = await supabase
        .from('students_classes')
        .select(`
          student_id,
          profiles:student_id (name, email)
        `)
        .eq('class_id', class_id);

      if (!enrollmentError && enrollments && enrollments.length > 0) {
        const notificationPromises = enrollments.map(async (enrollment) => {
          const { data: notification, error: notifError } = await supabase
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
                teacher_name: classData.teacher?.name || 'Teacher',
                action_url: `/join-class/${meetingId}`,
                started_at: new Date().toISOString()
              },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }]);

          if (notifError) {
            console.error(`❌ Failed to notify student ${enrollment.student_id}:`, notifError);
          }
        });

        await Promise.allSettled(notificationPromises);
        console.log(`✅ Sent notifications to ${enrollments.length} students`);
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
      db_session_id: dbSession?.id // Store DB ID if available
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
      students_notified: true
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
      students_notified: true,
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

// Join video session (Students & Teachers)
router.post('/join-session', async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;

    console.log('🔗 JOIN-SESSION REQUEST:', { meeting_id, user_id });

    if (!meeting_id || !user_id) {
      return res.status(400).json({ 
        success: false,
        error: 'Meeting ID and User ID are required' 
      });
    }

    // Get session from memory
    const session = sessionManager.getSession(meeting_id);
    
    console.log('🔍 Session lookup result:', { 
      meeting_id, 
      sessionFound: !!session,
      sessionStatus: session?.status 
    });

    if (!session || session.status !== 'active') {
      const activeSessions = sessionManager.getActiveSessions();
      console.log('📊 ACTIVE SESSIONS AVAILABLE:', activeSessions.map(s => ({
        meeting_id: s.meeting_id,
        class_id: s.class_id,
        teacher_id: s.teacher_id
      })));

      return res.status(404).json({ 
        success: false,
        error: 'Active session not found',
        debug: {
          requested_meeting_id: meeting_id,
          active_sessions: activeSessions.map(s => s.meeting_id)
        }
      });
    }

    // Add user to participants if not already there
    if (!session.participants.includes(user_id)) {
      session.participants.push(user_id);
    }

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

    // Generate a valid UID (must be integer for Agora)
    const agoraUid = parseInt(user_id.replace(/[^0-9]/g, '').substring(0, 9)) || 0;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      session.channel_name,
      agoraUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    console.log('✅ USER JOINED SESSION:', { 
      meeting_id, 
      user_id, 
      agora_uid: agoraUid,
      channel: session.channel_name,
      channel_length: session.channel_name.length
    });

    res.json({
      success: true,
      meeting_id: meeting_id,
      meetingId: meeting_id,
      channel: session.channel_name,
      token,
      app_id: appId,
      appId: appId,
      uid: agoraUid, // Use the valid Agora UID
      session: session,
      class_title: session.class_title,
      is_memory_session: true
    });

  } catch (error) {
    console.error('❌ Error joining video session:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
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
