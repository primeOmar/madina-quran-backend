// routes/video.js - PRODUCTION READY
import express from 'express';
import pkg from 'agora-access-token'; 
const { RtcTokenBuilder, RtcRole } = pkg; 
import { supabase } from '../server.js';

const router = express.Router();

// ==================== PRODUCTION CONSTANTS & CONFIG ====================
const AGORA_TOKEN_EXPIRY = 3600; // 1 hour
const SESSION_CLEANUP_INTERVAL = 300000; // 5 minutes
const SESSION_MAX_AGE = 60 * 60 * 1000; // 1 hour
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000;

// ==================== PRODUCTION LOGGER ====================
class ProductionLogger {
  static info(message, data = null) {
    console.log(`ℹ️ [VIDEO-ROUTES] ${message}`, data || '');
  }

  static error(message, error = null) {
    console.error(`❌ [VIDEO-ROUTES] ${message}`, error || '');
  }

  static warn(message, data = null) {
    console.warn(`⚠️ [VIDEO-ROUTES] ${message}`, data || '');
  }

  static debug(message, data = null) {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`🐛 [VIDEO-ROUTES] ${message}`, data || '');
    }
  }
}

// ==================== SESSION MANAGER ====================
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), SESSION_CLEANUP_INTERVAL);
    ProductionLogger.info('Session Manager initialized');
  }

  createSession(meetingId, sessionData) {
    ProductionLogger.info('Creating session', { meetingId });
    
    const session = {
      ...sessionData,
      lastActivity: Date.now(),
      created: Date.now(),
      participants: sessionData.participants || [],
      status: 'active'
    };
    
    this.sessions.set(meetingId, session);
    return session;
  }

  getSession(meetingId) {
    const session = this.sessions.get(meetingId);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session;
  }

  addParticipant(meetingId, userId) {
    const session = this.getSession(meetingId);
    if (session && !session.participants.includes(userId)) {
      session.participants.push(userId);
      ProductionLogger.debug('Participant added to memory session', { meetingId, userId });
    }
    return session;
  }

  removeParticipant(meetingId, userId) {
    const session = this.getSession(meetingId);
    if (session) {
      session.participants = session.participants.filter(id => id !== userId);
      ProductionLogger.debug('Participant removed from memory session', { meetingId, userId });
    }
    return session;
  }

  endSession(meetingId) {
    ProductionLogger.info('Ending session', { meetingId });
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
    let cleanedCount = 0;

    for (const [meetingId, session] of this.sessions.entries()) {
      if (now - session.created > SESSION_MAX_AGE || session.status === 'ended') {
        this.sessions.delete(meetingId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      ProductionLogger.info(`Cleaned up ${cleanedCount} old sessions`);
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      ProductionLogger.info('Session Manager destroyed');
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
  return channelName.length > 64 ? channelName.substring(0, 64) : channelName;
}

function generateValidMeetingId(classId) {
  const shortClassId = classId.substring(0, 8);
  return `class_${shortClassId}_${Date.now()}`;
}

function generateDeterministicUID(userId, meetingId) {
  const combined = `${userId}_${meetingId}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash) % 1000000;
}

function validateAgoraCredentials() {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  
  if (!appId || !appCertificate) {
    ProductionLogger.error('Agora credentials not configured');
    return false;
  }
  
  return { appId, appCertificate };
}

// ==================== DATABASE HELPERS ====================
async function getSessionIdFromMeetingId(meetingId) {
  try {
    const { data, error } = await supabase
      .from('video_sessions')
      .select('id, class_id, teacher_id')
      .eq('meeting_id', meetingId)
      .single();

    if (error) {
      ProductionLogger.error('Error getting session from meeting ID', { meetingId, error });
      return null;
    }

    return data;
  } catch (error) {
    ProductionLogger.error('Exception getting session from meeting ID', { meetingId, error });
    return null;
  }
}

async function recordParticipantJoin(meetingId, userId, userType = 'student') {
  try {
    const sessionData = await getSessionIdFromMeetingId(meetingId);
    if (!sessionData) {
      ProductionLogger.warn('No session found for meeting', { meetingId });
      return false;
    }

    const participantData = {
      session_id: sessionData.id,
      student_id: userId,
      is_teacher: userType === 'teacher',
      class_id: sessionData.class_id,
      joined_at: new Date().toISOString(),
      status: 'joined',
      connection_quality: 'excellent',
      device_info: {
        joined_via: 'video_routes',
        timestamp: new Date().toISOString()
      }
    };

    const { error } = await supabase
      .from('session_participants')
      .upsert(participantData, {
        onConflict: 'session_id,student_id'
      });

    if (error) {
      ProductionLogger.error('Error recording participant join', { meetingId, userId, error });
      return false;
    }

    ProductionLogger.info('Participant join recorded successfully', { meetingId, userId, userType });
    return true;
  } catch (error) {
    ProductionLogger.error('Exception recording participant join', { meetingId, userId, error });
    return false;
  }
}

async function updateParticipantLeave(meetingId, userId, duration = 0) {
  try {
    const sessionData = await getSessionIdFromMeetingId(meetingId);
    if (!sessionData) {
      ProductionLogger.warn('No session found for participant leave', { meetingId });
      return false;
    }

    const updateData = {
      left_at: new Date().toISOString(),
      duration: Math.max(0, Math.round(duration)),
      status: 'left',
      connection_quality: 'excellent'
    };

    const { error } = await supabase
      .from('session_participants')
      .update(updateData)
      .eq('session_id', sessionData.id)
      .eq('student_id', userId)
      .is('left_at', null);

    if (error) {
      ProductionLogger.error('Error updating participant leave', { meetingId, userId, error });
      return false;
    }

    ProductionLogger.info('Participant leave recorded successfully', { meetingId, userId, duration });
    return true;
  } catch (error) {
    ProductionLogger.error('Exception updating participant leave', { meetingId, userId, error });
    return false;
  }
}

async function getSessionParticipants(meetingId) {
  try {
    const sessionData = await getSessionIdFromMeetingId(meetingId);
    if (!sessionData) return [];

    const { data, error } = await supabase
      .from('session_participants')
      .select('student_id, is_teacher, joined_at, status')
      .eq('session_id', sessionData.id)
      .is('left_at', null);

    if (error) {
      ProductionLogger.error('Error getting session participants', { meetingId, error });
      return [];
    }

    return data || [];
  } catch (error) {
    ProductionLogger.error('Exception getting session participants', { meetingId, error });
    return [];
  }
}

async function updateSessionParticipantCount(sessionId) {
  try {
    const { data: participants, error } = await supabase
      .from('session_participants')
      .select('id, is_teacher, status')
      .eq('session_id', sessionId)
      .is('left_at', null);

    if (error) throw error;

    const studentCount = participants.filter(p => !p.is_teacher && p.status === 'joined').length;
    const teacherCount = participants.filter(p => p.is_teacher && p.status === 'joined').length;

    await supabase
      .from('video_sessions')
      .update({
        participant_count: studentCount + teacherCount,
        student_count: studentCount,
        teacher_count: teacherCount,
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId);

    ProductionLogger.debug('Session participant count updated', { sessionId, studentCount, teacherCount });
  } catch (error) {
    ProductionLogger.error('Error updating session participant count', { sessionId, error });
  }
}

async function validateStudentAccess(classId, studentId) {
  try {
    ProductionLogger.debug('Validating student access', { classId, studentId });
    
    // Get class teacher
    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('teacher_id, status')
      .eq('id', classId)
      .single();

    if (classError || !classData) {
      ProductionLogger.error('Class not found for access validation', { classId, classError });
      return false;
    }

    // Get student profile
    const { data: studentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('teacher_id, status')
      .eq('id', studentId)
      .single();

    if (profileError || !studentProfile) {
      ProductionLogger.error('Student profile not found', { studentId, profileError });
      return false;
    }

    // Check if student has same teacher as class
    const hasAccess = studentProfile.teacher_id === classData.teacher_id;
    
    ProductionLogger.debug('Access validation result', { 
      hasAccess, 
      studentTeacher: studentProfile.teacher_id, 
      classTeacher: classData.teacher_id 
    });
    
    return hasAccess;
  } catch (error) {
    ProductionLogger.error('Error in access validation', { classId, studentId, error });
    return false;
  }
}

// ==================== MIDDLEWARE ====================
const validateRequest = (requiredFields) => (req, res, next) => {
  const missingFields = requiredFields.filter(field => !req.body[field]);
  
  if (missingFields.length > 0) {
    ProductionLogger.warn('Missing required fields', { missingFields });
    return res.status(400).json({
      success: false,
      error: `Missing required fields: ${missingFields.join(', ')}`
    });
  }
  
  next();
};

// ==================== PRODUCTION ROUTES ====================

// Health Check - PRODUCTION READY
router.get('/health', async (req, res) => {
  try {
    const credentials = validateAgoraCredentials();
    
    // Test database connection
    const { data, error } = await supabase
      .from('video_sessions')
      .select('count')
      .limit(1);

    const healthStatus = {
      success: true,
      status: credentials ? 'healthy' : 'degraded',
      video_enabled: !!credentials,
      database_connected: !error,
      active_sessions: sessionManager.getActiveSessions().length,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      version: '1.0.0'
    };

    ProductionLogger.debug('Health check completed', healthStatus);
    res.json(healthStatus);
  } catch (error) {
    ProductionLogger.error('Health check failed', error);
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Session Status - PRODUCTION READY
router.get('/session-status/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;
    ProductionLogger.info('Session status request', { meetingId });

    // Check memory sessions first
    const memorySession = sessionManager.getSession(meetingId);
    if (memorySession) {
      const teacherPresent = memorySession.participants?.includes(memorySession.teacher_id) || false;
      const studentCount = memorySession.participants?.filter(id => id !== memorySession.teacher_id).length || 0;

      const response = {
        success: true,
        is_active: memorySession.status === 'active',
        is_teacher_joined: teacherPresent,
        student_count: studentCount,
        started_at: memorySession.started_at,
        session: memorySession,
        source: 'memory'
      };

      ProductionLogger.debug('Session status from memory', response);
      return res.json(response);
    }

    // Check database
    const { data: dbSession, error: dbError } = await supabase
      .from('video_sessions')
      .select('id, meeting_id, status, started_at, channel_name, class_id, teacher_id')
      .eq('meeting_id', meetingId)
      .single();

    if (dbError || !dbSession) {
      ProductionLogger.warn('Session not found in database', { meetingId });
      return res.status(404).json({
        success: false,
        is_active: false,
        is_teacher_joined: false,
        student_count: 0,
        error: 'Session not found'
      });
    }

    const participants = await getSessionParticipants(meetingId);
    const teacherPresent = participants.some(p => p.is_teacher);
    const studentCount = participants.filter(p => !p.is_teacher).length;

    const response = {
      success: true,
      is_active: dbSession.status === 'active',
      is_teacher_joined: teacherPresent,
      student_count: studentCount,
      started_at: dbSession.started_at,
      session: dbSession,
      source: 'database'
    };

    ProductionLogger.debug('Session status from database', response);
    res.json(response);

  } catch (error) {
    ProductionLogger.error('Session status error', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Start Session - PRODUCTION READY
router.post('/start-session', validateRequest(['class_id', 'user_id']), async (req, res) => {
  try {
    const { class_id, user_id } = req.body;
    ProductionLogger.info('Starting session', { class_id, user_id });

    // Validate class and teacher
    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('id, title, teacher_id, status')
      .eq('id', class_id)
      .single();

    if (classError || !classData) {
      ProductionLogger.error('Class not found', { class_id, classError });
      return res.status(404).json({ 
        success: false, 
        error: 'Class not found' 
      });
    }

    if (classData.teacher_id !== user_id) {
      ProductionLogger.error('Unauthorized session start attempt', { class_id, user_id, classTeacher: classData.teacher_id });
      return res.status(403).json({ 
        success: false, 
        error: 'Not authorized to start this session' 
      });
    }

    // Generate session identifiers
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
        started_at: new Date().toISOString(),
        participant_count: 0,
        student_count: 0,
        teacher_count: 1
      }])
      .select()
      .single();

    if (dbError) {
      ProductionLogger.error('Database session creation failed', { class_id, user_id, dbError });
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

    // Create memory session
    const sessionData = {
      id: dbSession.id,
      class_id,
      teacher_id: user_id,
      status: 'active',
      started_at: new Date().toISOString(),
      channel_name: channelName,
      class_title: classData.title,
      participants: [user_id],
      db_session_id: dbSession.id
    };

    const session = sessionManager.createSession(meetingId, sessionData);

    // Generate Agora token
    const credentials = validateAgoraCredentials();
    if (!credentials) {
      return res.status(500).json({ 
        success: false, 
        error: 'Video service not configured' 
      });
    }

    const token = RtcTokenBuilder.buildTokenWithUid(
      credentials.appId,
      credentials.appCertificate,
      channelName,
      user_id,
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + AGORA_TOKEN_EXPIRY
    );

    // Record teacher participation
    await recordParticipantJoin(meetingId, user_id, 'teacher');

    ProductionLogger.info('Session started successfully', { meetingId, channelName });

    res.json({
      success: true,
      meeting_id: meetingId,
      channel: channelName,
      token,
      app_id: credentials.appId,
      uid: user_id,
      session: session,
      class_title: classData.title
    });

  } catch (error) {
    ProductionLogger.error('Start session error', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Join Session - PRODUCTION READY
router.post('/join-session', validateRequest(['meeting_id', 'user_id']), async (req, res) => {
  try {
    const { meeting_id, user_id, user_type = 'student', user_name = 'Student' } = req.body;
    ProductionLogger.info('Join session request', { meeting_id, user_id, user_type });

    // Get session from memory or database
    let session = sessionManager.getSession(meeting_id);
    let dbSession = null;

    if (!session) {
      // Try to get session from database
      const { data: sessionData, error: dbError } = await supabase
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

      if (dbError || !sessionData) {
        ProductionLogger.error('Session not found', { meeting_id });
        return res.status(404).json({
          success: false,
          error: 'Active session not found'
        });
      }

      dbSession = sessionData;

      // Create memory session from database
      session = sessionManager.createSession(meeting_id, {
        ...sessionData,
        class_title: sessionData.classes?.title,
        teacher_name: sessionData.classes?.teacher?.name,
        participants: []
      });
    }

    if (session.status !== 'active') {
      ProductionLogger.error('Session not active', { meeting_id, status: session.status });
      return res.status(404).json({
        success: false,
        error: 'Active session not found or ended'
      });
    }

    // Validate student access
    if (user_type === 'student') {
      const hasAccess = await validateStudentAccess(session.class_id, user_id);
      if (!hasAccess) {
        ProductionLogger.error('Student not authorized', { class_id: session.class_id, user_id });
        return res.status(403).json({
          success: false,
          error: 'Student not authorized to join this class'
        });
      }
    }

    // Generate Agora credentials
    const credentials = validateAgoraCredentials();
    if (!credentials) {
      return res.status(500).json({
        success: false,
        error: 'Video service not configured'
      });
    }

    // Generate UID
    let agoraUid;
    if (user_type === 'teacher') {
      agoraUid = 1; // Teacher always gets UID 1
    } else {
      agoraUid = generateDeterministicUID(user_id, meeting_id) + 1000; // Students get 1000+
    }

    // Ensure UID is valid
    agoraUid = Math.max(1, Math.min(4294967295, agoraUid));

    // Generate token
    const token = RtcTokenBuilder.buildTokenWithUid(
      credentials.appId,
      credentials.appCertificate,
      session.channel_name,
      agoraUid,
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + AGORA_TOKEN_EXPIRY
    );

    // Record participation (non-blocking)
    recordParticipantJoin(meeting_id, user_id, user_type)
      .then(success => {
        if (success) {
          sessionManager.addParticipant(meeting_id, user_id);
        }
      })
      .catch(err => {
        ProductionLogger.error('Failed to record participation', err);
      });

    ProductionLogger.info('User joined session successfully', {
      meeting_id,
      user_id,
      user_type,
      agora_uid: agoraUid
    });

    const response = {
      success: true,
      meetingId: meeting_id,
      channel: session.channel_name,
      token,
      appId: credentials.appId,
      app_id: credentials.appId,
      uid: agoraUid,
      sessionInfo: {
        id: session.id,
        class_id: session.class_id,
        teacher_id: session.teacher_id,
        status: session.status,
        class_title: session.class_title,
        teacher_name: session.teacher_name
      }
    };

    res.json(response);

  } catch (error) {
    ProductionLogger.error('Join session error', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// Leave Session - PRODUCTION READY
router.post('/leave-session', validateRequest(['meeting_id', 'user_id']), async (req, res) => {
  try {
    const { meeting_id, user_id, duration = 0, user_type = 'student' } = req.body;
    ProductionLogger.info('Leave session request', { meeting_id, user_id, duration });

    // Update memory session
    sessionManager.removeParticipant(meeting_id, user_id);

    // Update database (non-blocking)
    updateParticipantLeave(meeting_id, user_id, duration)
      .then(success => {
        if (success) {
          ProductionLogger.info('Participant leave recorded in database', { meeting_id, user_id });
        }
      })
      .catch(err => {
        ProductionLogger.error('Failed to record participant leave', err);
      });

    res.json({
      success: true,
      message: 'Successfully left session'
    });

  } catch (error) {
    ProductionLogger.error('Leave session error', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Record Participation - PRODUCTION READY
router.post('/record-participation', validateRequest(['session_id', 'student_id']), async (req, res) => {
  try {
    const {
      session_id,
      student_id,
      is_teacher = false,
      joined_at,
      left_at,
      status = 'joined',
      connection_quality = 'unknown',
      duration = 0,
      device_info = {},
      class_id,
      error_details
    } = req.body;

    ProductionLogger.info('Record participation request', {
      session_id,
      student_id,
      status,
      is_teacher,
      duration
    });

    // Validate session exists
    const { data: session, error: sessionError } = await supabase
      .from('video_sessions')
      .select('id, class_id, meeting_id')
      .eq('id', session_id)
      .single();

    if (sessionError || !session) {
      ProductionLogger.error('Session not found for participation', { session_id });
      return res.status(404).json({
        success: false,
        error: 'Video session not found'
      });
    }

    // Prepare participation data
    const participationData = {
      session_id: session_id,
      student_id: student_id,
      is_teacher: Boolean(is_teacher),
      status: status,
      connection_quality: connection_quality,
      device_info: {
        ...device_info,
        recorded_via: 'record-participation-endpoint',
        timestamp: new Date().toISOString()
      },
      class_id: class_id || session.class_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Add optional fields
    if (joined_at) participationData.joined_at = joined_at;
    if (left_at) participationData.left_at = left_at;
    if (duration > 0) participationData.duration = Math.round(duration);
    if (error_details) participationData.error_details = error_details;

    // Upsert participation record
    const { data, error } = await supabase
      .from('session_participants')
      .upsert(participationData, {
        onConflict: 'session_id,student_id'
      })
      .select()
      .single();

    if (error) {
      ProductionLogger.error('Database upsert error', error);
      throw error;
    }

    // Update participant counts (non-blocking)
    updateSessionParticipantCount(session_id)
      .catch(err => ProductionLogger.warn('Failed to update participant count', err));

    ProductionLogger.info('Participation recorded successfully', { session_id, student_id });

    res.json({
      success: true,
      data: data,
      message: 'Participation recorded successfully'
    });

  } catch (error) {
    ProductionLogger.error('Record participation error', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// End Session - PRODUCTION READY
router.post('/end-session', validateRequest(['meeting_id', 'user_id']), async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;
    ProductionLogger.info('End session request', { meeting_id, user_id });

    const session = sessionManager.getSession(meeting_id);
    if (!session || session.teacher_id !== user_id) {
      ProductionLogger.error('Unauthorized session end attempt', { meeting_id, user_id });
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
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('meeting_id', meeting_id);

    // Update class status
    await supabase
      .from('classes')
      .update({ status: 'completed' })
      .eq('id', session.class_id);

    ProductionLogger.info('Session ended successfully', { meeting_id });

    res.json({
      success: true,
      message: 'Session ended successfully'
    });

  } catch (error) {
    ProductionLogger.error('End session error', error);
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
    
    ProductionLogger.debug('Active sessions retrieved', { count: activeSessions.length });
    
    res.json({
      success: true,
      active_sessions: activeSessions,
      count: activeSessions.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    ProductionLogger.error('Get active sessions error', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Get Session Participants - PRODUCTION READY
router.get('/session-participants/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;
    ProductionLogger.debug('Get session participants', { meetingId });

    const participants = await getSessionParticipants(meetingId);

    res.json({
      success: true,
      participants: participants,
      count: participants.length,
      meeting_id: meetingId
    });

  } catch (error) {
    ProductionLogger.error('Get session participants error', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// ==================== ERROR HANDLING ====================
router.use('*', (req, res) => {
  ProductionLogger.warn('Route not found', { path: req.originalUrl, method: req.method });
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl
  });
});

router.use((error, req, res, next) => {
  ProductionLogger.error('Unhandled error in video routes', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// ==================== CLEANUP ====================
process.on('SIGINT', () => {
  ProductionLogger.info('SIGINT received, cleaning up...');
  sessionManager.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  ProductionLogger.info('SIGTERM received, cleaning up...');
  sessionManager.destroy();
  process.exit(0);
});

export default router;
