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
      .select('id')
      .eq('meeting_id', meetingId)
      .single();
    return error ? null : data.id;
  } catch (error) {
    return null;
  }
}

async function recordParticipantJoin(meetingId, userId, userType) {
  try {
    const sessionId = await getSessionIdFromMeetingId(meetingId);
    if (!sessionId) return false;

    const { error } = await supabase
      .from('session_participants')
      .insert({
        session_id: sessionId,
        user_id: userId,
        user_type: userType,
        joined_at: new Date().toISOString()
      });

    return !error;
  } catch (error) {
    return false;
  }
}

async function updateDatabaseParticipantLeave(meetingId, userId, duration) {
  try {
    const sessionId = await getSessionIdFromMeetingId(meetingId);
    if (!sessionId) return false;

    const { error } = await supabase
      .from('session_participants')
      .update({
        left_at: new Date().toISOString(),
        duration: Math.max(0, duration || 0)
      })
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .is('left_at', null);

    return !error;
  } catch (error) {
    return false;
  }
}

async function getSessionParticipants(meetingId) {
  try {
    const sessionId = await getSessionIdFromMeetingId(meetingId);
    if (!sessionId) return [];

    const { data, error } = await supabase
      .from('session_participants')
      .select('user_id, user_type, joined_at')
      .eq('session_id', sessionId)
      .is('left_at', null);

    return error ? [] : (data || []);
  } catch (error) {
    return [];
  }
}

// ==================== ROUTES ====================

// Session Status
router.get('/session-status/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;
    console.log('🔍 SESSION-STATUS:', meetingId);

    // Check memory sessions first
    const memorySession = sessionManager.getSession(meetingId);
    if (memorySession) {
      const teacherPresent = memorySession.participants?.includes(memorySession.teacher_id) || false;
      const studentCount = memorySession.participants?.filter(id => id !== memorySession.teacher_id).length || 0;

      return res.json({
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
        is_active: false,
        is_teacher_joined: false,
        student_count: 0,
        error: 'Session not found'
      });
    }

    const participants = await getSessionParticipants(meetingId);
    const teacherPresent = participants.some(p => p.user_type === 'teacher');
    const studentCount = participants.filter(p => p.user_type === 'student').length;

    res.json({
      is_active: dbSession.status === 'active',
      is_teacher_joined: teacherPresent,
      student_count: studentCount,
      started_at: dbSession.started_at,
      session: dbSession,
      source: 'database'
    });

  } catch (error) {
    console.error('❌ Session status error:', error);
    res.json({
      is_active: false,
      is_teacher_joined: false,
      student_count: 0,
      error: 'Server error'
    });
  }
});

// Start Session
router.post('/start-session', async (req, res) => {
  try {
    const { class_id, user_id } = req.body;
    console.log('🎬 START-SESSION:', { class_id, user_id });

    if (!class_id || !user_id) {
      return res.status(400).json({ success: false, error: 'Class ID and User ID required' });
    }

    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('id, title, teacher_id, status')
      .eq('id', class_id)
      .single();

    if (classError || !classData) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }

    if (classData.teacher_id !== user_id) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const meetingId = generateValidMeetingId(class_id);
    const channelName = generateValidChannelName(class_id, user_id);

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

    if (dbError) console.error('❌ DB insertion failed:', dbError);

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
      return res.status(500).json({ success: false, error: 'Video service not configured' });
    }

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      user_id,
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + 3600
    );

    console.log('✅ SESSION STARTED:', meetingId);

    res.json({
      success: true,
      meeting_id: meetingId,
      channel: channelName,
      token,
      app_id: appId,
      uid: user_id,
      session: session
    });

  } catch (error) {
    console.error('❌ Start session error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Join Session
router.post('/join-session', async (req, res) => {
  try {
    const { meeting_id, user_id, user_type = 'student' } = req.body;
    console.log('🔗 JOIN-SESSION:', { meeting_id, user_id, user_type });

    if (!meeting_id || !user_id) {
      return res.status(400).json({ success: false, error: 'Meeting ID and User ID required' });
    }

    const session = sessionManager.getSession(meeting_id);
    if (!session || session.status !== 'active') {
      return res.status(404).json({ success: false, error: 'Active session not found' });
    }

    if (user_type === 'student') {
      const { data: studentProfile } = await supabase
        .from('profiles')
        .select('teacher_id')
        .eq('id', user_id)
        .single();

      if (!studentProfile?.teacher_id || studentProfile.teacher_id !== session.teacher_id) {
        return res.status(403).json({ success: false, error: 'Not authorized' });
      }
    }

    if (!session.participants.includes(user_id)) {
      session.participants.push(user_id);
    }

    await recordParticipantJoin(meeting_id, user_id, user_type);

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    
    if (!appId || !appCertificate) {
      return res.status(500).json({ success: false, error: 'Video service not configured' });
    }

    const agoraUid = parseInt(user_id.replace(/[^0-9]/g, '').substring(0, 9)) || Date.now() % 1000000;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      session.channel_name,
      agoraUid,
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + 3600
    );

    console.log('✅ USER JOINED:', user_id);

    res.json({
      success: true,
      meeting_id: meeting_id,
      channel: session.channel_name,
      token,
      app_id: appId,
      uid: agoraUid,
      session: session
    });

  } catch (error) {
    console.error('❌ Join session error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Leave Session
router.post('/leave-session', async (req, res) => {
  try {
    const { meeting_id, user_id, duration = 0, user_type = 'student' } = req.body;
    console.log('🚪 LEAVE-SESSION:', { meeting_id, user_id });

    if (!meeting_id || !user_id) {
      return res.status(400).json({ success: false, error: 'Meeting ID and User ID required' });
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
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Health Check
router.get('/health', (req, res) => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  
  res.json({
    status: appId && appCertificate ? 'healthy' : 'unhealthy',
    videoEnabled: !!(appId && appCertificate),
    activeSessions: sessionManager.getActiveSessions().length,
    timestamp: new Date().toISOString()
  });
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
