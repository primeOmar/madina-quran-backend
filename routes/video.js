// ============================================
// Additional Video Session API Endpoints
// ============================================

import express from 'express';
import pkg from 'agora-access-token';
const { RtcTokenBuilder, RtcRole } = pkg;
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../server.js';

const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

const router = express.Router();

// ============================================
// POST /api/agora/generate-token
// Generates a new Agora token (for token renewal)
// ============================================

router.post('/generate-token', async (req, res) => {
  const { meetingId, userId } = req.body;

  try {
    const { data: session, error } = await supabase
      .from('video_sessions')
      .select('id, channel_name, status, teacher_id')
      .eq('meeting_id', meetingId)
      .single();

    if (error || !session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    if (session.status !== 'active') {
      return res.status(400).json({
        success: false,
        error: 'Session is not active'
      });
    }

    // Verify user is participant
    const { data: participant } = await supabase
      .from('video_session_participants')
      .select('user_type, status')
      .eq('session_id', session.id)
      .eq('user_id', userId)
      .single();

    if (!participant || participant.status !== 'joined') {
      return res.status(403).json({
        success: false,
        error: 'User is not an active participant'
      });
    }

    const uid = parseInt(userId.replace(/-/g, '').substring(0, 10), 16);
    const role = participant.user_type === 'teacher' ? 'publisher' : 'publisher';
    
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expirationTimestamp = currentTimestamp + 3600;
    
    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      session.channel_name,
      uid,
      role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
      expirationTimestamp
    );

    res.json({
      success: true,
      token: token,
      uid: uid,
      expiresAt: expirationTimestamp
    });

  } catch (error) {
    console.error('Generate token error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate token',
      message: error.message
    });
  }
});

// ============================================
// GET /api/agora/active-sessions
// Retrieves all active sessions (for admin/monitoring)
// ============================================

router.get('/active-sessions', async (req, res) => {
  const { teacherId, classId, limit = 50, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('video_sessions')
      .select(`
        *,
        classes!inner(id, title),
        profiles!inner(id, full_name),
        video_session_analytics(peak_participants, total_unique_participants)
      `)
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (teacherId) {
      query = query.eq('teacher_id', teacherId);
    }

    if (classId) {
      query = query.eq('class_id', classId);
    }

    const { data: sessions, error, count } = await query;

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      sessions: sessions || [],
      total: count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

  } catch (error) {
    console.error('Get active sessions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve sessions',
      message: error.message
    });
  }
});

// ============================================
// POST /api/agora/validate-session
// Validates if a session is accessible to a user
// ============================================

router.post('/validate-session', async (req, res) => {
  const { meetingId, userId } = req.body;

  try {
    const { data: session, error } = await supabase
      .from('video_sessions')
      .select(`
        id,
        meeting_id,
        class_id,
        teacher_id,
        status,
        participant_count,
        video_session_settings(max_participants)
      `)
      .eq('meeting_id', meetingId)
      .single();

    if (error || !session) {
      return res.json({
        success: false,
        valid: false,
        reason: 'Session not found'
      });
    }

    if (session.status !== 'active') {
      return res.json({
        success: false,
        valid: false,
        reason: `Session is ${session.status}`
      });
    }

    // Check if user is teacher
    const isTeacher = session.teacher_id === userId;

    // Check if user is enrolled (for students)
    let isEnrolled = false;
    if (!isTeacher) {
      const { data: enrollment } = await supabase
        .from('student_classes')
        .select('id')
        .eq('class_id', session.class_id)
        .eq('student_id', userId)
        .maybeSingle();

      isEnrolled = !!enrollment;
    }

    if (!isTeacher && !isEnrolled) {
      return res.json({
        success: false,
        valid: false,
        reason: 'User not authorized for this session'
      });
    }

    // Check max participants
    const maxParticipants = session.video_session_settings?.[0]?.max_participants || 50;
    if (session.participant_count >= maxParticipants) {
      return res.json({
        success: false,
        valid: false,
        reason: 'Session has reached maximum capacity'
      });
    }

    res.json({
      success: true,
      valid: true,
      session: {
        id: session.id,
        meetingId: session.meeting_id,
        status: session.status,
        participantCount: session.participant_count,
        maxParticipants: maxParticipants
      },
      userRole: isTeacher ? 'teacher' : 'student'
    });

  } catch (error) {
    console.error('Validate session error:', error);
    res.status(500).json({
      success: false,
      error: 'Validation failed',
      message: error.message
    });
  }
});

// ============================================
// GET /api/agora/class-sessions/:classId
// Gets all sessions for a specific class
// ============================================

router.get('/class-sessions/:classId', async (req, res) => {
  const { classId } = req.params;
  const { status, limit = 20, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('video_sessions')
      .select(`
        *,
        video_session_analytics(
          peak_participants,
          total_unique_participants,
          average_duration
        )
      `, { count: 'exact' })
      .eq('class_id', classId)
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data: sessions, error, count } = await query;

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      sessions: sessions || [],
      total: count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

  } catch (error) {
    console.error('Get class sessions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve class sessions',
      message: error.message
    });
  }
});

// ============================================
// PUT /api/agora/update-participant/:sessionId
// Updates participant status/settings
// ============================================

router.put('/update-participant/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { userId, updates } = req.body;

  try {
    // Validate session exists
    const { data: session, error: sessionError } = await supabase
      .from('video_sessions')
      .select('id, status')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Get participant
    const { data: participant, error: participantError } = await supabase
      .from('video_session_participants')
      .select('*')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .single();

    if (participantError || !participant) {
      return res.status(404).json({
        success: false,
        error: 'Participant not found'
      });
    }

    // Allowed updates
    const allowedUpdates = {
      status: updates.status,
      audio_enabled: updates.audioEnabled,
      video_enabled: updates.videoEnabled,
      screen_sharing: updates.screenSharing,
      connection_quality: updates.connectionQuality
    };

    // Remove undefined values
    Object.keys(allowedUpdates).forEach(key => 
      allowedUpdates[key] === undefined && delete allowedUpdates[key]
    );

    // Handle status change to 'left'
    if (allowedUpdates.status === 'left') {
      const leftAt = new Date().toISOString();
      const duration = Math.floor(
        (new Date(leftAt) - new Date(participant.joined_at)) / 1000
      );
      
      allowedUpdates.left_at = leftAt;
      allowedUpdates.duration = duration;
    }

    // Update participant
    const { data: updated, error: updateError } = await supabase
      .from('video_session_participants')
      .update(allowedUpdates)
      .eq('id', participant.id)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    res.json({
      success: true,
      participant: updated
    });

  } catch (error) {
    console.error('Update participant error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update participant',
      message: error.message
    });
  }
});

// ============================================
// POST /api/agora/send-message
// Sends a chat message in a session
// ============================================

router.post('/send-message', async (req, res) => {
  const { sessionId, userId, messageText, messageType = 'text', fileUrl, fileName } = req.body;

  try {
    // Verify user is participant
    const { data: participant } = await supabase
      .from('video_session_participants')
      .select('id, status')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .eq('status', 'joined')
      .single();

    if (!participant) {
      return res.status(403).json({
        success: false,
        error: 'Only active participants can send messages'
      });
    }

    // Create message
    const { data: message, error } = await supabase
      .from('video_session_messages')
      .insert({
        session_id: sessionId,
        user_id: userId,
        message_text: messageText,
        message_type: messageType,
        file_url: fileUrl,
        file_name: fileName
      })
      .select(`
        *,
        profiles!inner(id, full_name, avatar_url)
      `)
      .single();

    if (error) {
      throw error;
    }

    // Update analytics
    await supabase.rpc('increment_session_messages', { 
      session_id: sessionId 
    });

    res.json({
      success: true,
      message: message
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send message',
      message: error.message
    });
  }
});

// ============================================
// GET /api/agora/session-messages/:sessionId
// Retrieves chat messages for a session
// ============================================

router.get('/session-messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { limit = 50, before } = req.query;

  try {
    let query = supabase
      .from('video_session_messages')
      .select(`
        *,
        profiles!inner(id, full_name, avatar_url)
      `)
      .eq('session_id', sessionId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data: messages, error } = await query;

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      messages: messages || []
    });

  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve messages',
      message: error.message
    });
  }
});

// ============================================
// POST /api/agora/start-recording
// Starts recording a session
// ============================================

router.post('/start-recording', async (req, res) => {
  const { sessionId, userId } = req.body;

  try {
    // Verify user is teacher/host
    const { data: session } = await supabase
      .from('video_sessions')
      .select('id, teacher_id, meeting_id')
      .eq('id', sessionId)
      .single();

    if (!session || session.teacher_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only the session host can start recording'
      });
    }

    // Update settings
    await supabase
      .from('video_session_settings')
      .update({ recording_enabled: true })
      .eq('session_id', sessionId);

    // Create recording record
    const { data: recording, error } = await supabase
      .from('video_session_recordings')
      .insert({
        session_id: sessionId,
        recording_url: `pending_${session.meeting_id}`,
        status: 'processing',
        recording_start: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      recording: recording
    });

  } catch (error) {
    console.error('Start recording error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start recording',
      message: error.message
    });
  }
});


export default router;
