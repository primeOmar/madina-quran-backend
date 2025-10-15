import express from 'express';
import pkg from 'agora-access-token'; 
const { RtcTokenBuilder, RtcRole } = pkg; 
import { supabase, clearCache } from '../server.js';

const router = express.Router();

// ==================== TOKEN GENERATION ====================
router.post('/generate-token', async (req, res) => {
  req.setTimeout(5000); // 5 second timeout
  
  try {
    const { channelName, uid, role = 'publisher' } = req.body;

    if (!channelName) {
      return res.status(400).json({ 
        success: false,
        error: 'Channel name is required' 
      });
    }

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    
    if (!appId || appId === '""' || appId === "''") {
      console.error('❌ AGORA_APP_ID is missing or empty:', appId);
      return res.status(500).json({ 
        success: false,
        error: 'Video service configuration missing',
        isFallback: true
      });
    }

    if (!appCertificate || appCertificate === '""' || appCertificate === "''") {
      console.error('❌ AGORA_APP_CERTIFICATE is missing or empty');
      return res.status(500).json({ 
        success: false,
        error: 'Video service certificate missing',
        isFallback: true
      });
    }

    console.log('🔐 Generating token for channel:', channelName);

    const expirationTime = 3600; // 1 hour
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;

    const userRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid || 0,
      userRole,
      privilegeExpiredTs
    );

    res.json({
      success: true,
      token,
      appId, 
      channelName,
      uid: uid || 0,
      expiresAt: privilegeExpiredTs,
      isFallback: false 
    });

  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to generate token',
      isFallback: true 
    });
  }
});

// ==================== VIDEO SESSION MANAGEMENT ====================

// Start video session (Teacher)
// Update the start-session route with detailed debugging
router.post('/start-session', async (req, res) => {
  try {
    const { class_id, user_id } = req.body;

    console.log('🎬 Starting video session:', { class_id, user_id });

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
      .select('id, title, teacher_id, status, scheduled_date')
      .eq('id', class_id)
      .single();

    console.log('🔍 Class lookup result:', { classData, classError });

    if (classError || !classData) {
      return res.status(404).json({ 
        success: false,
        error: 'Class not found' 
      });
    }

    // Check if user is the teacher of this class
    if (classData.teacher_id !== user_id) {
      console.log('❌ Teacher authorization failed:', { 
        classTeacher: classData.teacher_id, 
        requestingUser: user_id 
      });
      return res.status(403).json({ 
        success: false,
        error: 'Not authorized to start this class session' 
      });
    }

    // Generate unique meeting ID and channel name
    const meetingId = `class_${class_id}_${Date.now()}`;
    const channelName = `class_${class_id}_${user_id}`;

    console.log('📝 Creating session with:', { meetingId, channelName });

    // Create new video session in database
    const { data: newSession, error: sessionError } = await supabase
      .from('video_sessions')
      .insert([
        {
          class_id,
          teacher_id: user_id,
          meeting_id: meetingId,
          status: 'active',
          started_at: new Date().toISOString(),
          channel_name: channelName,
          agenda: `Quran Class: ${classData.title}`,
          scheduled_date: classData.scheduled_date
        }
      ])
      .select()
      .single(); // Remove the complex select for debugging

    console.log('🔍 Session creation result:', { newSession, sessionError });

    if (sessionError) {
      console.error('❌ Detailed session creation error:', {
        message: sessionError.message,
        details: sessionError.details,
        hint: sessionError.hint,
        code: sessionError.code
      });
      return res.status(500).json({ 
        success: false,
        error: `Failed to create video session: ${sessionError.message}`,
        details: sessionError.details
      });
    }

    // Generate Agora token for the teacher
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    
    if (!appId || !appCertificate) {
      console.log('⚠️ Agora credentials missing');
      return res.status(500).json({ 
        success: false,
        error: 'Video service not configured',
        isFallback: true
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

    console.log('✅ Video session started successfully:', meetingId);

    // Clear cache for live sessions
    clearCache('liveSessions');

    res.json({
      success: true,
      meeting_id: meetingId,
      meetingId: meetingId,
      channel: channelName,
      token,
      app_id: appId,
      appId: appId,
      uid: user_id,
      session: newSession,
      class_title: classData.title
    });

  } catch (error) {
    console.error('❌ Unhandled error in start-session:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});
// Join video session (Students & Teachers)
router.post('/join-session', async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;

    console.log('🔗 Joining video session:', { meeting_id, user_id });

    // Validate inputs
    if (!meeting_id || !user_id) {
      return res.status(400).json({ 
        success: false,
        error: 'Meeting ID and User ID are required' 
      });
    }

    // Get session details
    const { data: session, error: sessionError } = await supabase
      .from('video_sessions')
      .select(`
        *,
        classes (
          id,
          title,
          teacher_id
        ),
        profiles:teacher_id (
          name
        )
      `)
      .eq('meeting_id', meeting_id)
      .eq('status', 'active')
      .single();

    if (sessionError || !session) {
      return res.status(404).json({ 
        success: false,
        error: 'Active session not found' 
      });
    }

    // Check if user is authorized to join this session
    // For students: Check if they're enrolled in the class
    // For teachers: Check if they're the teacher of this class
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('role, teacher_id')
      .eq('id', user_id)
      .single();

    if (userProfile.role === 'student') {
      const { data: enrollment } = await supabase
        .from('students_classes')
        .select('id')
        .eq('class_id', session.class_id)
        .eq('student_id', user_id)
        .single();

      if (!enrollment) {
        return res.status(403).json({ 
          success: false,
          error: 'Not enrolled in this class' 
        });
      }
    } else if (userProfile.role === 'teacher' && session.teacher_id !== user_id) {
      return res.status(403).json({ 
        success: false,
        error: 'Not authorized to join this session' 
      });
    }

    // Generate Agora token
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    
    if (!appId || !appCertificate) {
      return res.status(500).json({ 
        success: false,
        error: 'Video service not configured',
        isFallback: true
      });
    }

    const expirationTime = 3600; // 1 hour
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

    console.log('✅ User joined video session:', { meeting_id, user_id, role: userProfile.role });

    res.json({
      success: true,
      meeting_id: meeting_id,
      meetingId: meeting_id, // Both formats for compatibility
      channel: session.channel_name,
      token,
      app_id: appId,
      appId: appId, // Both formats for compatibility
      uid: user_id,
      session: session,
      class_title: session.classes?.title,
      teacher_name: session.profiles?.name,
      user_role: userProfile.role
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

    console.log('🛑 Ending video session:', { meeting_id, user_id });

    if (!meeting_id) {
      return res.status(400).json({ 
        success: false,
        error: 'Meeting ID is required' 
      });
    }

    // Get session and verify teacher ownership
    const { data: session, error: sessionError } = await supabase
      .from('video_sessions')
      .select('id, teacher_id, class_id')
      .eq('meeting_id', meeting_id)
      .single();

    if (sessionError || !session) {
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

    // Update session status
    const { data, error } = await supabase
      .from('video_sessions')
      .update({ 
        status: 'ended', 
        ended_at: new Date().toISOString() 
      })
      .eq('meeting_id', meeting_id)
      .select(`
        *,
        classes (
          title
        )
      `)
      .single();

    if (error) {
      console.error('❌ Error ending session:', error);
      return res.status(500).json({ 
        success: false,
        error: 'Failed to end session' 
      });
    }

    // Clear cache
    clearCache('liveSessions');

    console.log('✅ Video session ended:', meeting_id);

    res.json({
      success: true,
      message: 'Session ended successfully',
      session: data,
      class_title: data.classes?.title
    });

  } catch (error) {
    console.error('❌ Error ending video session:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

// Leave video session (Students & Teachers)
router.post('/leave-session', async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;

    console.log('🚪 Leaving video session:', { meeting_id, user_id });

    // Just log the leave event - no database changes needed
    const { data: session } = await supabase
      .from('video_sessions')
      .select('class_id, classes(title)')
      .eq('meeting_id', meeting_id)
      .single();

    console.log('✅ User left video session:', { 
      meeting_id, 
      user_id, 
      class: session?.classes?.title 
    });

    res.json({
      success: true,
      message: 'Left session successfully'
    });

  } catch (error) {
    console.error('❌ Error in leave session:', error);
    // Still return success since leaving is client-side
    res.json({
      success: true,
      message: 'Session left'
    });
  }
});

// ==================== SESSION QUERIES ====================

// Get active sessions
router.get('/active-sessions', async (req, res) => {
  try {
    const { data: sessions, error } = await supabase
      .from('video_sessions')
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
          id,
          title,
          scheduled_date
        ),
        profiles:teacher_id (
          id,
          name,
          email
        )
      `)
      .eq('status', 'active')
      .order('started_at', { ascending: false });

    if (error) {
      console.error('❌ Error fetching active sessions:', error);
      return res.status(500).json({ 
        success: false,
        error: 'Failed to fetch sessions' 
      });
    }

    res.json({
      success: true,
      sessions: sessions || []
    });

  } catch (error) {
    console.error('❌ Error fetching active sessions:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

// Get session by meeting ID
router.get('/session/:meeting_id', async (req, res) => {
  try {
    const { meeting_id } = req.params;

    const { data: session, error } = await supabase
      .from('video_sessions')
      .select(`
        *,
        classes (
          title,
          scheduled_date
        ),
        profiles:teacher_id (
          name,
          email
        )
      `)
      .eq('meeting_id', meeting_id)
      .single();

    if (error || !session) {
      return res.status(404).json({ 
        success: false,
        error: 'Session not found' 
      });
    }

    res.json({
      success: true,
      session
    });

  } catch (error) {
    console.error('❌ Error fetching session:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

// Get teacher's active sessions
router.get('/teacher/:teacher_id/sessions', async (req, res) => {
  try {
    const { teacher_id } = req.params;
    const { status = 'active' } = req.query;

    const { data: sessions, error } = await supabase
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
          title
        )
      `)
      .eq('teacher_id', teacher_id)
      .eq('status', status)
      .order('started_at', { ascending: false });

    if (error) {
      console.error('❌ Error fetching teacher sessions:', error);
      return res.status(500).json({ 
        success: false,
        error: 'Failed to fetch sessions' 
      });
    }

    res.json({
      success: true,
      sessions: sessions || []
    });

  } catch (error) {
    console.error('❌ Error fetching teacher sessions:', error);
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

// ==================== HEALTH & DEBUG ====================

// Health check for video service
router.get('/health', (req, res) => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  
  const hasAppId = !!(appId && appId !== '""' && appId !== "''");
  const hasCertificate = !!(appCertificate && appCertificate !== '""' && appCertificate !== "''");
  
  res.json({
    status: hasAppId && hasCertificate ? 'healthy' : 'unhealthy',
    videoEnabled: hasAppId && hasCertificate,
    appIdConfigured: hasAppId,
    appCertificateConfigured: hasCertificate,
    timestamp: new Date().toISOString(),
    appIdPreview: hasAppId ? '***' + appId.slice(-4) : 'missing',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Debug endpoint to check environment variables (remove in production)
router.get('/debug-config', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }
  
  res.json({
    AGORA_APP_ID: process.env.AGORA_APP_ID ? '***' + process.env.AGORA_APP_ID.slice(-4) : 'MISSING',
    AGORA_APP_CERTIFICATE: process.env.AGORA_APP_CERTIFICATE ? '***' + process.env.AGORA_APP_CERTIFICATE.slice(-4) : 'MISSING',
    NODE_ENV: process.env.NODE_ENV,
    hasAppId: !!(process.env.AGORA_APP_ID && process.env.AGORA_APP_ID !== '""'),
    hasCertificate: !!(process.env.AGORA_APP_CERTIFICATE && process.env.AGORA_APP_CERTIFICATE !== '""')
  });
});

export default router;
