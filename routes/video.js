import express from 'express';
import pkg from 'agora-access-token'; 
const { RtcTokenBuilder, RtcRole } = pkg; 
import { supabase } from '../server.js';

const router = express.Router();

// Fix for express-rate-limit proxy issue
router.use((req, res, next) => {
  // Trust proxy for rate limiting
  req.connection.encrypted = req.connection.encrypted || req.headers['x-forwarded-proto'] === 'https';
  next();
});

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

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
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

// 🔧 FIXED: Get session UUID from meeting_id
async function getSessionIdFromMeetingId(meetingId) {
  try {
    const { data, error } = await supabase
      .from('video_sessions')
      .select('id')
      .eq('meeting_id', meetingId)
      .single();

    if (error || !data) {
      console.warn('⚠️ Could not find session ID for meeting:', meetingId);
      return null;
    }
    
    return data.id;
  } catch (error) {
    console.warn('⚠️ Error getting session ID:', error.message);
    return null;
  }
}

// 🔧 FIXED: Safe participant handling
async function recordParticipantJoin(meetingId, userId, userType) {
  try {
    const sessionId = await getSessionIdFromMeetingId(meetingId);
    if (!sessionId) {
      console.warn('⚠️ No session ID found, skipping database recording');
      return false;
    }

    const { error } = await supabase
      .from('session_participants')
      .insert({
        session_id: sessionId, // Use the UUID session_id, not meeting_id string
        user_id: userId,
        user_type: userType,
        joined_at: new Date().toISOString()
      });

    if (error) {
      console.warn('⚠️ Could not record participant in database:', error.message);
      return false;
    }
    
    console.log('✅ Participant recorded in database:', userId);
    return true;
  } catch (error) {
    console.warn('⚠️ Database recording failed:', error.message);
    return false;
  }
}

// 🔧 FIXED: Safe participant leave handling
async function updateDatabaseParticipantLeave(meetingId, userId, duration) {
  try {
    const sessionId = await getSessionIdFromMeetingId(meetingId);
    if (!sessionId) {
      console.warn('⚠️ No session ID found, skipping database update');
      return false;
    }

    const { error } = await supabase
      .from('session_participants')
      .update({
        left_at: new Date().toISOString(),
        duration: Math.max(0, duration || 0),
        updated_at: new Date().toISOString()
      })
      .eq('session_id', sessionId) // Use UUID session_id
      .eq('user_id', userId)
      .is('left_at', null);

    if (error) {
      console.warn('⚠️ Could not update participant leave:', error.message);
      return false;
    }
    
    console.log('✅ Participant leave recorded in database:', userId);
    return true;
  } catch (error) {
    console.warn('⚠️ Database update failed:', error.message);
    return false;
  }
}

// 🔧 FIXED: Safe participant fetching
async function getSessionParticipants(meetingId) {
  try {
    const sessionId = await getSessionIdFromMeetingId(meetingId);
    if (!sessionId) {
      console.warn('⚠️ No session ID found, returning empty participants');
      return [];
    }

    const { data, error } = await supabase
      .from('session_participants')
      .select(`
        user_id,
        user_type,
        joined_at,
        left_at,
        duration
      `)
      .eq('session_id', sessionId) // Use UUID session_id
      .is('left_at', null);

    if (error) {
      console.warn('⚠️ Could not fetch participants:', error.message);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.warn('⚠️ Error fetching participants:', error.message);
    return [];
  }
}

// ==================== SESSION STATUS ENDPOINT ====================

router.get('/session-status/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;
    
    console.log('🔍 SESSION-STATUS REQUEST:', { meetingId });

    if (!meetingId) {
      return res.status(400).json({ 
        success: false,
        error: 'Meeting ID is required' 
      });
    }

    // First check memory sessions (real-time)
    const memorySession = sessionManager.getSession(meetingId);
    
    if (memorySession) {
      const teacherPresent = memorySession.participants?.includes(memorySession.teacher_id) || false;
      const studentCount = memorySession.participants?.filter(id => id !== memorySession.teacher_id).length || 0;

      return res.json({
        is_active: memorySession.status === 'active',
        is_teacher_joined: teacherPresent,
        student_count: studentCount,
        started_at: memorySession.started_at,
        session: {
          id: memorySession.id,
          meeting_id: meetingId,
          status: memorySession.status,
          channel_name: memorySession.channel_name,
          class_id: memorySession.class_id,
          teacher_id: memorySession.teacher_id
        },
        source: 'memory'
      });
    }

    // Fallback to database check
    const { data: dbSession, error: dbError } = await supabase
      .from('video_sessions')
      .select(`
        id,
        meeting_id,
        status,
        started_at,
        ended_at,
        channel_name,
        class_id,
        teacher_id
      `)
      .eq('meeting_id', meetingId)
      .single();

    if (dbError || !dbSession) {
      return res.status(404).json({ 
        success: false,
        error: 'Session not found',
        is_active: false,
        is_teacher_joined: false,
        student_count: 0
      });
    }

    // 🔧 FIXED: Safe participant fetching
    const participants = await getSessionParticipants(meetingId);
    const teacherPresent = participants.some(p => p.user_type === 'teacher') || false;
    const studentCount = participants.filter(p => p.user_type === 'student').length || 0;

    res.json({
      is_active: dbSession.status === 'active',
      is_teacher_joined: teacherPresent,
      student_count: studentCount,
      started_at: dbSession.started_at,
      session: {
        id: dbSession.id,
        meeting_id: dbSession.meeting_id,
        status: dbSession.status,
        channel_name: dbSession.channel_name,
        class_id: dbSession.class_id,
        teacher_id: dbSession.teacher_id
      },
      participants: participants,
      source: 'database'
    });

  } catch (error) {
    console.error('❌ Error getting session status:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      is_active: false,
      is_teacher_joined: false,
      student_count: 0
    });
  }
});

// ==================== JOIN SESSION ====================

router.post('/join-session', async (req, res) => {
  try {
    const { meeting_id, user_id, user_type = 'student' } = req.body;

    console.log('🔗 JOIN-SESSION REQUEST:', { meeting_id, user_id, user_type });

    if (!meeting_id || !user_id) {
      return res.status(400).json({ 
        success: false,
        error: 'Meeting ID and User ID are required' 
      });
    }

    const session = sessionManager.getSession(meeting_id);
    
    if (!session || session.status !== 'active') {
      return res.status(404).json({ 
        success: false,
        error: 'Active session not found'
      });
    }

    // Add user to participants if not already there
    if (!session.participants.includes(user_id)) {
      session.participants.push(user_id);
      console.log('✅ Added user to session participants:', user_id);
    }

    // 🔧 FIXED: Safe database recording
    await recordParticipantJoin(meeting_id, user_id, user_type);

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

    const agoraUid = parseInt(user_id.replace(/[^0-9]/g, '').substring(0, 9)) || Date.now() % 1000000;

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
      user_type,
      participants_count: session.participants.length
    });

    res.json({
      success: true,
      meeting_id: meeting_id,
      meetingId: meeting_id,
      channel: session.channel_name,
      token,
      app_id: appId,
      appId: appId,
      uid: agoraUid,
      session: session,
      class_title: session.class_title,
      user_type: user_type
    });

  } catch (error) {
    console.error('❌ Error joining video session:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

// ==================== LEAVE SESSION ====================

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
      // Still try to update database if possible
      await updateDatabaseParticipantLeave(meeting_id, user_id, duration);
      return res.json({ 
        success: true, 
        message: 'Session not found, but marked as left'
      });
    }

    // Remove user from participants
    if (session.participants) {
      session.participants = session.participants.filter(id => id !== user_id);
    }

    // 🔧 FIXED: Safe database update
    await updateDatabaseParticipantLeave(meeting_id, user_id, duration);

    res.json({
      success: true,
      message: 'Successfully left session',
      remaining_participants: session.participants?.length || 0
    });

  } catch (error) {
    console.error('❌ Error leaving video session:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

// Export the router
export default router;
