import express from 'express';
import pkg from 'agora-access-token'; 
const { RtcTokenBuilder, RtcRole } = pkg; 
import { supabase } from '../server.js';

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

async function updateDatabaseParticipantLeave(sessionId, userId, duration) {
  try {
    const { error: updateError } = await supabase
      .from('session_participants')
      .update({
        left_at: new Date().toISOString(),
        duration: Math.max(0, duration || 0),
        updated_at: new Date().toISOString()
      })
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .is('left_at', null);

    if (updateError) {
      console.error('❌ Error updating participant leave in database:', updateError);
    } else {
      console.log('✅ Participant leave recorded in database:', userId);
    }
  } catch (error) {
    console.error('❌ Database update failed for participant leave:', error);
  }
}

// ==================== TOKEN GENERATION ====================

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

// ==================== SESSION MANAGEMENT ====================

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
        started_at: new Date().toISOString(),
        scheduled_date: new Date().toISOString(),
        agenda: `Live class: ${classData.title}`
      }])
      .select()
      .single();

    if (dbError) {
      console.error('❌ Database insertion failed:', dbError);
    }

    await supabase
      .from('classes')
      .update({ status: 'active' })
      .eq('id', class_id);

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

          if (!notifError) notifiedStudents++;
          return notifError;
        });

        await Promise.allSettled(notificationPromises);
      }
    } catch (notifError) {
      console.error('❌ Notification sending failed:', notifError);
    }

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
      participant_count: 1
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

// ==================== SESSION STATUS & PARTICIPANTS ====================

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
        teacher_id,
        classes (
          teacher_id
        )
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

    const { data: participants, error: participantsError } = await supabase
      .from('session_participants')
      .select(`
        user_id,
        user_type,
        joined_at,
        profiles:user_id (
          name,
          email
        )
      `)
      .eq('session_id', dbSession.id)
      .is('left_at', null);

    if (participantsError) {
      console.error('Error fetching participants:', participantsError);
    }

    const teacherPresent = participants?.some(p => p.user_type === 'teacher') || false;
    const studentCount = participants?.filter(p => p.user_type === 'student').length || 0;

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
      participants: participants || [],
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
      const activeSessions = sessionManager.getActiveSessions();
      return res.status(404).json({ 
        success: false,
        error: 'Active session not found',
        debug: {
          requested_meeting_id: meeting_id,
          active_sessions: activeSessions.map(s => s.meeting_id)
        }
      });
    }

    if (user_type === 'student') {
      const { data: studentProfile } = await supabase
        .from('profiles')
        .select('teacher_id')
        .eq('id', user_id)
        .single();

      if (!studentProfile?.teacher_id || studentProfile.teacher_id !== session.teacher_id) {
        return res.status(403).json({ 
          success: false,
          error: 'Not authorized to join this session' 
        });
      }
    }

    if (!session.participants.includes(user_id)) {
      session.participants.push(user_id);
    }

    try {
      const { error: participantError } = await supabase
        .from('session_participants')
        .insert({
          session_id: session.db_session_id || session.id,
          user_id: user_id,
          user_type: user_type,
          joined_at: new Date().toISOString()
        });

      if (participantError) {
        console.error('❌ Error recording participant in database:', participantError);
      }
    } catch (dbError) {
      console.error('❌ Database participant recording failed:', dbError);
    }

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
      user_type: user_type,
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
      await updateDatabaseParticipantLeave(meeting_id, user_id, duration);
      return res.json({ 
        success: true, 
        message: 'Session not found, but marked as left',
        session_ended: true
      });
    }

    if (session.participants) {
      session.participants = session.participants.filter(id => id !== user_id);
    }

    await updateDatabaseParticipantLeave(session.db_session_id || session.id, user_id, duration);

    if (user_type === 'teacher' && (!session.participants || session.participants.length === 0)) {
      sessionManager.endSession(meeting_id);
      
      await supabase
        .from('video_sessions')
        .update({
          status: 'ended',
          ended_at: new Date().toISOString()
        })
        .eq('meeting_id', meeting_id);
    }

    res.json({
      success: true,
      message: 'Successfully left session',
      session_ended: user_type === 'teacher' && (!session.participants || session.participants.length === 0),
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

router.get('/session-participants/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;

    console.log('👥 SESSION-PARTICIPANTS REQUEST:', { meetingId });

    if (!meetingId) {
      return res.status(400).json({ 
        success: false,
        error: 'Meeting ID is required' 
      });
    }

    const memorySession = sessionManager.getSession(meetingId);
    let memoryParticipants = [];

    if (memorySession && memorySession.participants) {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, name, email, role')
        .in('id', memorySession.participants);

      if (!profilesError && profiles) {
        memoryParticipants = profiles.map(profile => ({
          user_id: profile.id,
          name: profile.name,
          email: profile.email,
          role: profile.role,
          joined_at: memorySession.started_at,
          source: 'memory'
        }));
      }
    }

    const { data: dbParticipants, error: dbError } = await supabase
      .from('session_participants')
      .select(`
        user_id,
        user_type,
        joined_at,
        left_at,
        duration,
        profiles:user_id (
          name,
          email
        )
      `)
      .eq('session_id', memorySession?.db_session_id || meetingId)
      .order('joined_at', { ascending: true });

    const databaseParticipants = (dbParticipants || []).map(p => ({
      user_id: p.user_id,
      name: p.profiles?.name,
      email: p.profiles?.email,
      user_type: p.user_type,
      joined_at: p.joined_at,
      left_at: p.left_at,
      duration: p.duration,
      source: 'database'
    }));

    const allParticipants = [
      ...memoryParticipants,
      ...databaseParticipants.filter(db => 
        !memoryParticipants.some(mem => mem.user_id === db.user_id)
      )
    ];

    res.json({
      success: true,
      participants: allParticipants,
      total_count: allParticipants.length,
      active_count: memoryParticipants.length,
      meeting_id: meetingId
    });

  } catch (error) {
    console.error('❌ Error getting session participants:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

// ==================== DEBUG & MONITORING ====================

router.get('/active-sessions', async (req, res) => {
  try {
    const memorySessions = sessionManager.getActiveSessions();
    
    const { data: dbSessions, error } = await supabase
      .from('video_sessions')
      .select(`
        *,
        class:classes (title, teacher_id, description),
        teacher:profiles (name, email)
      `)
      .eq('status', 'active')
      .order('started_at', { ascending: false });

    const allSessions = [
      ...memorySessions,
      ...(dbSessions || []).map(session => ({
        ...session,
        is_db_session: true,
        participants: session.participants || []
      }))
    ];

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

// Cleanup on process exit
process.on('SIGINT', () => {
  console.log('🛑 Shutting down session manager...');
  sessionManager.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down session manager...');
  sessionManager.destroy();
  process.exit(0);
});

export default router;
