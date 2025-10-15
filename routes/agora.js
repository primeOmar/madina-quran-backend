import express from 'express';
import pkg from 'agora-access-token'; 
const { RtcTokenBuilder, RtcRole } = pkg; 
import { supabase, clearCache } from '../server.js';

const router = express.Router();

// Enhanced in-memory storage with auto-cleanup
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000); // Clean every 5 minutes
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
      session.lastActivity = Date.now(); // Update activity time
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

  deleteSession(meetingId) {
    this.sessions.delete(meetingId);
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
      // Remove sessions older than 1 hour or ended sessions
      if (now - session.created > oneHour || session.status === 'ended') {
        console.log('🧹 Cleaning up old session:', meetingId);
        this.sessions.delete(meetingId);
      }
    }
  }
}

const sessionManager = new SessionManager();

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

    // Generate unique meeting ID and channel name
    const meetingId = `class_${class_id}_${Date.now()}`;
    const channelName = `class_${class_id}_${user_id}`;

    console.log('📝 Generated session details:', { meetingId, channelName });

    // Create session in memory
    const sessionData = {
      id: meetingId,
      class_id,
      teacher_id: user_id,
      status: 'active',
      started_at: new Date().toISOString(),
      channel_name: channelName,
      class_title: classData.title,
      participants: [user_id] // Start with teacher as participant
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

    const expirationTime = 3600; // 1 hour
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
      teacher: user_id,
      activeSessions: sessionManager.sessions.size 
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
      // Debug: List all active sessions to help troubleshoot
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

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      session.channel_name,
      user_id,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    console.log('✅ USER JOINED SESSION:', { 
      meeting_id, 
      user_id, 
      participants: session.participants.length,
      channel: session.channel_name 
    });

    res.json({
      success: true,
      meeting_id: meeting_id,
      meetingId: meeting_id,
      channel: session.channel_name,
      token,
      app_id: appId,
      appId: appId,
      uid: user_id,
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

    // Get session from memory
    const session = sessionManager.getSession(meeting_id);
    
    if (!session) {
      return res.status(404).json({ 
        success: false,
        error: 'Session not found' 
      });
    }

    // Verify teacher ownership
    if (session.teacher_id !== user_id) {
      return res.status(403).json({ 
        success: false,
        error: 'Only the teacher can end this session' 
      });
    }

    // End session in memory
    sessionManager.endSession(meeting_id);

    console.log('✅ SESSION ENDED:', meeting_id);

    res.json({
      success: true,
      message: 'Session ended successfully',
      session: session,
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
    const sessions = sessionManager.getActiveSessions();
    
    console.log('📊 ACTIVE SESSIONS QUERY:', { count: sessions.length });

    res.json({
      success: true,
      sessions: sessions,
      total_count: sessions.length,
      is_memory_sessions: true
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
    participants_count: session.participants?.length || 0
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
