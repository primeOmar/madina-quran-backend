import express from 'express';
import pkg from 'agora-access-token';
const { RtcTokenBuilder, RtcRole } = pkg;
import { supabase, clearCache } from '../server.js';

const router = express.Router();

// ==================== ENHANCED SESSION MANAGER ====================
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
      participants: sessionData.participants || [],
      agora_uids: sessionData.agora_uids || {},
      teacher_joined: sessionData.teacher_joined || false,
      teacher_agora_uid: sessionData.teacher_agora_uid || null
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
  
  getSessionByTeacher(teacherId) {
    for (const [meetingId, session] of this.sessions.entries()) {
      if (session.teacher_id === teacherId && session.status === 'active') {
        return { meetingId, session };
      }
    }
    return null;
  }

  endSession(meetingId) {
    console.log('🛑 Ending session in memory:', meetingId);
    const session = this.sessions.get(meetingId);
    if (session) {
      session.status = 'ended';
      session.ended_at = new Date().toISOString();
      console.log('✅ Session ended in memory:', meetingId);
    } else {
      console.warn('⚠️ Session not found in memory for ending:', meetingId);
    }
  }
  
  addParticipant(meetingId, userId, agoraUid, isTeacher = false) {
    const session = this.sessions.get(meetingId);
    if (session) {
      if (!session.participants.includes(userId)) {
        session.participants.push(userId);
      }
      session.agora_uids[userId] = agoraUid;
      
      if (isTeacher) {
        session.teacher_joined = true;
        session.teacher_agora_uid = agoraUid;
      }
      
      console.log('➕ Added participant:', { meetingId, userId, agoraUid, isTeacher });
      return true;
    }
    return false;
  }
  
  removeParticipant(meetingId, userId) {
    const session = this.sessions.get(meetingId);
    if (session) {
      session.participants = session.participants.filter(id => id !== userId);
      delete session.agora_uids[userId];
      
      if (userId === session.teacher_id) {
        session.teacher_joined = false;
        delete session.teacher_agora_uid;
      }
      
      console.log('➖ Removed participant:', { meetingId, userId });
      return true;
    }
    return false;
  }
  
  getParticipantCount(meetingId) {
    const session = this.sessions.get(meetingId);
    return session ? session.participants.length : 0;
  }
  
  isTeacherPresent(meetingId) {
    const session = this.sessions.get(meetingId);
    return session ? session.teacher_joined : false;
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
function generateDynamicMeetingId(classId, userId = null) {
  if (userId) {
    // Teacher-specific: class_{classId}_teacher_{teacherShortId}
    const shortUserId = userId.substring(0, 8).replace(/[^a-zA-Z0-9]/g, '');
    return `class_${classId}_teacher_${shortUserId}`;
  } else {
    // Generic/fallback: class_{classId}
    return `class_${classId}`;
  }
}

function generateMatchingChannelName(meetingId) {
  // Channel name should match meeting ID
  return `channel_${meetingId}`;
}

function generateUniqueAgoraUid() {
  // Agora UID range: 1 to 4294967295
  // Avoid UID 1 as it might be problematic
  let uid;
  do {
    uid = Math.floor(Math.random() * 100000) + 1000; // 1000-100999
  } while (uid === 1);
  return uid;
}



router.post('/generate-fresh-token', async (req, res) => {
  try {
    const { channelName, uid, role = 'publisher' } = req.body;
    
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    
    if (!appId || !appCertificate) {
      return res.status(500).json({
        success: false,
        error: 'Agora credentials not configured'
      });
    }
    
    // Generate token with fresh expiration
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
    
    res.json({
      success: true,
      token,
      appId,
      channelName,
      uid,
      expiresAt: privilegeExpiredTs * 1000
    });
    
  } catch (error) {
    console.error('❌ Token generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate token'
    });
  }
});
// ==================== START SESSION (TEACHER) - DYNAMIC ====================
router.post('/start-session', async (req, res) => {
  try {
    const { class_id, user_id, requested_meeting_id, requested_channel_name } = req.body;
    
    console.log('TEACHER STARTING SESSION:', {
      class_id,
      user_id,
      requested_meeting_id,
      requested_channel_name,
      hasRequestedId: !!requested_meeting_id
    });

    // Generate dynamic IDs
    const timestamp = Date.now();
    const meetingId = requested_meeting_id || `class_${class_id.replace(/-/g, '_')}_teacher_${user_id.substring(0, 8)}`;
    const channelName = requested_channel_name || generateShortChannelName(class_id, user_id);

// Add this helper function:
function generateShortChannelName(classId, userId) {
  // Create a hash of classId + userId to make it shorter
  const shortClassId = classId.substring(0, 8);
  const shortUserId = userId.substring(0, 8);
  const timestamp = Date.now().toString(36); 
  
  // Max 64 chars: "ch_" + shortClassId + "_" + shortUserId + "_" + timestamp
  return `ch_${shortClassId}_${shortUserId}_${timestamp}`.substring(0, 64);
}
    console.log('🔄 GENERATED DYNAMIC IDs:', {
      meetingId,
      channelName,
      teacherId: user_id
    });

    // Generate access code (6 characters)
    const generateAccessCode = () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return code;
    };

    const accessCode = generateAccessCode();

    // 1. Check for existing active session
    const { data: existingSession, error: findError } = await supabase
      .from('video_sessions')
      .select('*')
      .eq('class_id', class_id)
      .eq('status', 'active')
      .maybeSingle();

    let sessionData;

    if (existingSession) {
      // Update existing session
      const { data: updatedSession, error: updateError } = await supabase
        .from('video_sessions')
        .update({
          last_activity: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        })
        .eq('id', existingSession.id)
        .select()
        .single();
      
      if (updateError) throw updateError;
      
      sessionData = updatedSession;
      console.log('✅ Reusing existing session:', sessionData.meeting_id);
    } else {
      // Create new session
      const { data: newSession, error: createError } = await supabase
        .from('video_sessions')
        .insert({
          class_id: class_id,
          teacher_id: user_id,
          meeting_id: meetingId,
          channel_name: channelName,
          access_code: accessCode,
          status: 'active',
          started_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          is_dynamic_id: true
        })
        .select()
        .single();

      if (createError) {
        console.error('❌ Database error:', createError);
        throw new Error('Failed to create session in database: ' + createError.message);
      }

      if (!newSession) {
        throw new Error('Failed to create session in database');
      }

      sessionData = newSession;
      console.log('✅ Created new session:', sessionData.meeting_id);
    }

    // Generate Agora token (if using Agora)
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    const uid = 0; // Teacher UID
    const role = RtcRole.PUBLISHER;
    const expireTime = 3600; // 1 hour

    const token = appId && appCertificate ? 
      RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channelName, uid, role, expireTime) : 
      'demo_token';

    res.json({
  success: true,
  meetingId: sessionData.meeting_id,
  channel: sessionData.channel_name, 
  channelName: sessionData.channel_name, 
  accessCode: sessionData.access_code,
  token: token,
  appId: appId,
  uid: uid,
  teacherId: user_id,
  message: existingSession ? 'Rejoined existing session' : 'Session created successfully'
});
  } catch (error) {
    console.error('❌ Error in /start-session:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to start session',
      hint: 'Database connection issue'
    });
  }
});

// ==================== SMART JOIN SESSION ====================
router.post('/join-session', async (req, res) => {
  try {
    const { 
      meeting_id, 
      user_id, 
      user_type = 'student',
      role = 'student' // Alternative parameter name
    } = req.body;

    console.log('🔗 SMART JOIN-SESSION REQUEST:', { 
      meeting_id, 
      user_id, 
      user_type,
      role,
      timestamp: new Date().toISOString()
    });

    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required',
        code: 'MISSING_PARAMS'
      });
    }

    // Clean meeting_id
    const cleanMeetingId = meeting_id.replace(/["']/g, '').trim();
    const effectiveUserType = user_type || role || 'student';
    const isTeacher = effectiveUserType === 'teacher';
    
    console.log('🔍 Processing join for:', {
      cleanMeetingId,
      user_id,
      isTeacher,
      originalMeetingId: meeting_id
    });

    // ========== SMART MEETING ID RESOLUTION ==========
    let classId = null;
    let actualChannelName = cleanMeetingId;
    let sessionType = 'unknown';

    // Pattern 1: Teacher-specific ID (class_{classId}_teacher_{teacherId})
    const teacherPattern = /^class_([^_]+)_teacher_([^_]+)$/;
    const teacherMatch = cleanMeetingId.match(teacherPattern);

    // Pattern 2: Generic class ID (class_{classId})
    const genericPattern = /^class_([^_]+)$/;
    const genericMatch = cleanMeetingId.match(genericPattern);

    // Pattern 3: Channel pattern (channel_class_{classId}_teacher_{teacherId})
    const channelPattern = /^channel_class_([^_]+)(?:_teacher_([^_]+))?$/;
    const channelMatch = cleanMeetingId.match(channelPattern);

    if (teacherMatch) {
      // Teacher-specific meeting ID: class_123_teacher_tchr789
      classId = teacherMatch[1];
      const teacherId = teacherMatch[2];
      actualChannelName = `channel_${cleanMeetingId}`;
      sessionType = 'teacher_specific';
      console.log('👨‍🏫 TEACHER-SPECIFIC MEETING:', { 
        classId, 
        teacherId, 
        channel: actualChannelName,
        pattern: 'teacher_specific'
      });
    } else if (channelMatch) {
      // Channel name: channel_class_123 or channel_class_123_teacher_tchr789
      classId = channelMatch[1];
      const teacherId = channelMatch[2];
      actualChannelName = cleanMeetingId; // Already a channel name
      sessionType = teacherId ? 'teacher_channel' : 'generic_channel';
      console.log('🔗 CHANNEL NAME DETECTED:', { 
        classId, 
        teacherId,
        channel: actualChannelName,
        pattern: sessionType
      });
    } else if (genericMatch) {
      // Generic class meeting ID: class_123
      classId = genericMatch[1];
      actualChannelName = `channel_class_${classId}`;
      sessionType = 'generic_class';
      console.log('🎓 GENERIC CLASS MEETING:', { 
        classId, 
        channel: actualChannelName,
        pattern: 'generic_class'
      });
    } else {
      // Unknown format, try to use as-is
      console.log('⚠️ UNKNOWN MEETING ID FORMAT, using as-is:', cleanMeetingId);
      actualChannelName = cleanMeetingId;
    }

    // ========== FIND OR CREATE SESSION ==========
    let session = sessionManager.getSession(cleanMeetingId);
    let sessionRestored = false;
    
    if (!session) {
      console.log('🔄 Session not in memory, checking database...');
      
      // Try multiple ways to find the session
      let dbSession = null;
      
      // Method 1: Exact meeting ID match
      const { data: exactMatch } = await supabase
        .from('video_sessions')
        .select(`
          *,
          classes (
            title,
            teacher_id,
            id
          )
        `)
        .eq('meeting_id', cleanMeetingId)
        .eq('status', 'active')
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .single();

      if (exactMatch) {
        dbSession = exactMatch;
        console.log('✅ Found exact meeting ID match');
      } else if (classId) {
        // Method 2: Find by class ID (for students)
        const { data: classMatch } = await supabase
          .from('video_sessions')
          .select(`
            *,
            classes (
              title,
              teacher_id,
              id
            )
          `)
          .eq('class_id', classId)
          .eq('status', 'active')
          .is('ended_at', null)
          .order('started_at', { ascending: false })
          .limit(1)
          .single();
        
        if (classMatch) {
          dbSession = classMatch;
          console.log('✅ Found class ID match:', classId);
        }
      }

      if (dbSession) {
        // Restore session from database to memory
        session = sessionManager.createSession(dbSession.meeting_id, {
          id: dbSession.id,
          meeting_id: dbSession.meeting_id,
          class_id: dbSession.class_id,
          teacher_id: dbSession.teacher_id,
          status: 'active',
          started_at: dbSession.started_at,
          channel_name: dbSession.channel_name,
          class_title: dbSession.classes?.title,
          participants: [],
          db_session_id: dbSession.id,
          agora_uids: {},
          teacher_joined: false,
          is_dynamic_id: dbSession.is_dynamic_id || false
        });
        sessionRestored = true;
        console.log('🔄 Session restored from database');
      }
    }

    // ========== VALIDATE SESSION ==========
    if (!session) {
      console.error('❌ No active session found for:', {
        meetingId: cleanMeetingId,
        classId,
        sessionType,
        isTeacher
      });
      
      // If teacher is trying to join non-existent session, allow them to start one
      if (isTeacher && classId) {
        console.log('👨‍🏫 Teacher joining non-existent session, they should start one first');
      }
      
      return res.status(404).json({
        success: false,
        error: 'No active session found. Teacher needs to start the session first.',
        code: 'SESSION_NOT_FOUND',
        classId: classId,
        isTeacher: isTeacher,
        suggestedAction: isTeacher ? 'Call /start-session first' : 'Wait for teacher'
      });
    }

    // Teacher validation
    if (isTeacher && session.teacher_id !== user_id) {
      console.error('❌ Teacher authorization failed:', {
        sessionTeacher: session.teacher_id,
        requestingTeacher: user_id
      });
      return res.status(403).json({
        success: false,
        error: 'Not authorized to join this session as teacher.',
        code: 'TEACHER_AUTH_FAILED'
      });
    }

    // ========== TOKEN GENERATION ==========
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.status(500).json({
        success: false,
        error: 'Video service not configured',
        code: 'AGORA_CONFIG_MISSING'
      });
    }

    // Generate unique Agora UID
    let agoraUid = generateUniqueAgoraUid();
    
    // Ensure unique UID within this session
    while (Object.values(session.agora_uids || {}).includes(agoraUid)) {
      agoraUid = generateUniqueAgoraUid();
    }

    const expirationTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;

    // Use the CORRECT channel name
    const finalChannelName = session.channel_name || actualChannelName;
    
    console.log('🔗 Generating token for:', {
      user_id,
      role: isTeacher ? 'teacher' : 'student',
      channel: finalChannelName,
      uid: agoraUid,
      sessionType: sessionType
    });

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      finalChannelName,
      agoraUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    // Add participant to session
    sessionManager.addParticipant(session.meeting_id, user_id, agoraUid, isTeacher);

    // Log participant in database
    try {
      await supabase
        .from('session_participants')
        .upsert({
          session_id: session.db_session_id || session.id,
          user_id: user_id,
          role: isTeacher ? 'teacher' : 'student',
          status: 'joined',
          joined_at: new Date().toISOString(),
          agora_uid: agoraUid,
          channel_name: finalChannelName,
          meeting_id: session.meeting_id
        }, {
          onConflict: 'session_id,user_id'
        });
    } catch (dbError) {
      console.warn('⚠️ Database logging failed (non-critical):', dbError.message);
    }

    // ========== BUILD RESPONSE ==========
   const response = {
  success: true,
  // Frontend expects camelCase
  meetingId: session.meeting_id,
  channel: finalChannelName, 
  token: token,
  appId: appId,
  uid: agoraUid,
  role: isTeacher ? 'teacher' : 'student',
  
  // Session object
  session: {
    id: session.id,
    meeting_id: session.meeting_id,
    meetingId: session.meeting_id,
    class_id: session.class_id,
    teacher_id: session.teacher_id,
    status: session.status,
    class_title: session.class_title,
    channel: finalChannelName, 
    channel_name: finalChannelName,
    participants_count: sessionManager.getParticipantCount(session.meeting_id),
    teacher_joined: session.teacher_joined,
    is_dynamic_id: session.is_dynamic_id || false
  },
  
  // Additional info
  class_title: session.class_title,
  
  // Backward compatibility (snake_case)
  meeting_id: session.meeting_id,
  app_id: appId,
  user_type: isTeacher ? 'teacher' : 'student',
  is_teacher: isTeacher,
  teacher_present: session.teacher_joined,
  session_restored: sessionRestored,
  session_type: sessionType,
  class_id: classId,
  channel_synchronized: true,
  message: `Joined ${finalChannelName} as ${isTeacher ? 'teacher' : 'student'}`,
  debug: {
    originalMeetingId: meeting_id,
    cleanMeetingId,
    finalChannelName,
    sessionType,
    teacherId: session.teacher_id
  }
};

    console.log('✅ JOIN SUCCESSFUL - SAME CHANNEL AS TEACHER:', {
      meetingId: session.meeting_id,
      channel: finalChannelName,
      user_id,
      role: response.role,
      teacher_present: session.teacher_joined,
      participants: sessionManager.getParticipantCount(session.meeting_id),
      sessionType: sessionType
    });

    res.json(response);

  } catch (error) {
    console.error('❌ Error in join-session:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message,
      code: 'INTERNAL_ERROR'
    });
  }
});

// ==================== END SESSION ====================
router.post('/end-session', async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;

    console.log('🛑 END-SESSION REQUEST:', { meeting_id, user_id });

    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required'
      });
    }

    const session = sessionManager.getSession(meeting_id);

    if (!session) {
      // Try to find session in database
      const { data: dbSession } = await supabase
        .from('video_sessions')
        .select('*, classes(title, teacher_id)')
        .eq('meeting_id', meeting_id)
        .single();

      if (!dbSession) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      if (dbSession.teacher_id !== user_id) {
        return res.status(403).json({
          success: false,
          error: 'Only the teacher can end this session'
        });
      }

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
        .update({ status: 'finished' })
        .eq('id', dbSession.class_id);

      return res.json({
        success: true,
        message: 'Session ended successfully'
      });
    }

    // Check authorization
    if (session.teacher_id !== user_id) {
      return res.status(403).json({
        success: false,
        error: 'Only the teacher can end this session'
      });
    }

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
      .update({ status: 'finished' })
      .eq('id', session.class_id);

    // End session in memory
    sessionManager.endSession(meeting_id);

    console.log('✅ SESSION ENDED:', meeting_id);

    res.json({
      success: true,
      message: 'Session ended successfully',
      session: session
    });

  } catch (error) {
    console.error('❌ Error ending video session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== LEAVE SESSION ====================
router.post('/leave-session', async (req, res) => {
  try {
    const { meeting_id, user_id } = req.body;

    console.log('🚪 LEAVE-SESSION REQUEST:', { meeting_id, user_id });

    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required'
      });
    }

    const session = sessionManager.getSession(meeting_id);
    const isTeacher = session && session.teacher_id === user_id;

    // Remove from memory
    if (session) {
      sessionManager.removeParticipant(meeting_id, user_id);
    }

    // Update database status
    if (isTeacher) {
      // If teacher leaves, end the session
      await supabase
        .from('video_sessions')
        .update({
          status: 'ended',
          ended_at: new Date().toISOString()
        })
        .eq('meeting_id', meeting_id);
    } else {
      // Update participant status to left
      try {
        await supabase
          .from('session_participants')
          .update({
            status: 'left',
            left_at: new Date().toISOString()
          })
          .eq('session_id', session?.db_session_id)
          .eq('user_id', user_id);
      } catch (error) {
        console.warn('⚠️ Could not update participant status:', error.message);
      }
    }

    console.log('✅ USER LEFT SESSION:', {
      meeting_id,
      user_id,
      isTeacher
    });

    res.json({
      success: true,
      message: 'Successfully left video session',
      isTeacher: isTeacher,
      sessionEnded: isTeacher
    });

  } catch (error) {
    console.error('❌ Error leaving video session:', error);
    res.json({
      success: true,
      message: 'Left session'
    });
  }
});

// ==================== SESSION INFO ENDPOINTS ====================
router.get('/session-status/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;
    const session = sessionManager.getSession(meetingId);

    if (!session) {
      return res.json({
        success: true,
        exists: false,
        is_active: false,
        is_teacher_joined: false,
        participant_count: 0
      });
    }

    const teacherJoined = sessionManager.isTeacherPresent(meetingId);
    const studentCount = sessionManager.getParticipantCount(meetingId) - (teacherJoined ? 1 : 0);

    res.json({
      success: true,
      exists: true,
      is_active: session.status === 'active',
      is_teacher_joined: teacherJoined,
      teacher_id: session.teacher_id,
      student_count: studentCount,
      total_participants: sessionManager.getParticipantCount(meetingId),
      started_at: session.started_at,
      class_title: session.class_title,
      channel_name: session.channel_name
    });

  } catch (error) {
    console.error('❌ Error checking session status:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

router.get('/session-info/:meetingId', async (req, res) => {
  try {
    const { meetingId } = req.params;
    
    console.log('📡 Fetching session info for:', meetingId);

    // Query the database using supabase
    const { data: session, error: sessionError } = await supabase
      .from('video_sessions')
      .select(`
        *,
        classes!video_sessions_class_id_fkey (
          name
        ),
        profiles!video_sessions_teacher_id_fkey (
          name
        )
      `)
      .eq('meeting_id', meetingId)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!session) {
      console.log('❌ Session not found or expired:', meetingId);
      return res.status(404).json({
        success: false,
        error: 'Session not found or has expired',
        meetingId
      });
    }
    
    // Generate student token
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    const uid = Math.floor(Math.random() * 100000); // Random student UID
    const role = RtcRole.SUBSCRIBER;
    const expireTime = 3600;

    const token = appId && appCertificate ? 
      RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, session.channel_name, uid, role, expireTime) : 
      'demo_token';

    res.json({
  success: true,
  meetingId: session.meeting_id,
  channel: session.channel_name, 
  channelName: session.channel_name,
  accessCode: session.access_code,
  token: token,
  appId: appId,
  uid: uid,
  classId: session.class_id,
  className: session.classes?.name,
  teacherId: session.teacher_id,
  teacherName: session.profiles?.name,
  expiresAt: session.expires_at,
  isActive: session.status === 'active'
});
  } catch (error) {
    console.error('❌ Error in /session-info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch session information',
      meetingId: req.params.meetingId
    });
  }
});

router.get('/find-session/:classId', async (req, res) => {
  try {
    const { classId } = req.params;
    
    console.log('🔍 Finding active session for class:', classId);

    // USING SUPABASE
    const { data: session, error } = await supabase
      .from('video_sessions')
      .select('*')
      .eq('class_id', classId)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session) {
      return res.json({
        success: false,
        error: 'No active session found for this class',
        hint: 'Teacher needs to start the session first'
      });
    }
    
    res.json({
  success: true,
  meetingId: session.meeting_id,
  accessCode: session.access_code,
  channel: session.channel_name, 
  channelName: session.channel_name,
  teacherId: session.teacher_id,
  expiresAt: session.expires_at
});
  } catch (error) {
    console.error('❌ Error in /find-session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to find session'
    });
  }
});

// ==================== VALIDATE STUDENT JOIN (NO VALIDATION) ====================
router.post('/validate-student-join', async (req, res) => {
  try {
    const { class_id, student_id, meeting_id } = req.body;

    console.log('🔐 Validating student join (NO VALIDATION):', { class_id, student_id, meeting_id });

    // Find session
    let session = null;
    if (meeting_id) {
      session = sessionManager.getSession(meeting_id);
    } else {
      // Find session by class
      const { data: dbSession } = await supabase
        .from('video_sessions')
        .select('*')
        .eq('class_id', class_id)
        .eq('status', 'active')
        .is('ended_at', null)
        .single();
      
      if (dbSession) {
        session = {
          meeting_id: dbSession.meeting_id,
          class_id: dbSession.class_id,
          teacher_id: dbSession.teacher_id,
          status: dbSession.status,
          channel_name: dbSession.channel_name
        };
      }
    }

    if (!session) {
      return res.json({
        success: false,
        error: 'No active session found for this class',
        code: 'NO_ACTIVE_SESSION',
        canJoin: false
      });
    }

    const teacherPresent = sessionManager.isTeacherPresent(session.meeting_id);

    res.json({
      success: true,
      canJoin: true,
      meetingId: session.meeting_id,
      channel: session.channel_name,
      teacher_present: teacherPresent,
      validation: {
        session_active: true,
        teacher_present: teacherPresent,
        message: 'Anyone can join with the meeting link'
      }
    });

  } catch (error) {
    console.error('❌ Error validating student join:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      canJoin: false
    });
  }
});

// ==================== PARTICIPANTS MANAGEMENT ====================
router.post('/session-participants', async (req, res) => {
  try {
    const { meeting_id } = req.body;
    
    if (!meeting_id) {
      return res.json({
        success: true,
        participants: []
      });
    }
    
    const session = sessionManager.getSession(meeting_id);
    
    if (!session) {
      return res.json({
        success: true,
        participants: []
      });
    }

    // Get user details for participants
    const participantDetails = [];
    
    for (const userId of session.participants) {
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, name, email, avatar_url, role')
          .eq('id', userId)
          .single();
        
        participantDetails.push({
          user_id: userId,
          agora_uid: session.agora_uids[userId] || null,
          role: userId === session.teacher_id ? 'teacher' : 'student',
          joined_at: session.started_at,
          profile: profile || { name: 'Unknown User' },
          is_teacher: userId === session.teacher_id
        });
      } catch (error) {
        // Skip if profile not found
      }
    }

    res.json({
      success: true,
      participants: participantDetails,
      count: participantDetails.length
    });

  } catch (error) {
    console.error('❌ Error getting participants:', error);
    res.json({
      success: true,
      participants: []
    });
  }
});

router.post('/update-participant', async (req, res) => {
  try {
    const { session_id, user_id, ...updates } = req.body;
    
    console.log('🔄 Updating participant:', { session_id, user_id, updates });
    
    // Update in database
    const { error } = await supabase
      .from('session_participants')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('session_id', session_id)
      .eq('user_id', user_id);

    if (error) {
      console.warn('⚠️ Database update failed:', error);
      return res.json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      message: 'Participant updated'
    });

  } catch (error) {
    console.error('❌ Error updating participant:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== CHAT MESSAGES ====================
router.post('/session-messages', async (req, res) => {
  try {
    const { session_id, meeting_id, limit = 100 } = req.body;
    
    console.log('💬 GETTING SESSION MESSAGES:', { 
      session_id, 
      meeting_id,
      timestamp: new Date().toISOString()
    });
    
    // Use either session_id or meeting_id
    let sessionIdentifier = session_id;
    
    if (!sessionIdentifier && meeting_id) {
      // Get session ID from meeting ID
      const { data: videoSession } = await supabase
        .from('video_sessions')
        .select('id')
        .eq('meeting_id', meeting_id)
        .single();
      
      if (videoSession) {
        sessionIdentifier = videoSession.id;
      }
    }
    
    if (!sessionIdentifier) {
      console.warn('⚠️ No session identifier provided for messages');
      return res.json({
        success: true,
        messages: [],
        count: 0
      });
    }
    
    // Get messages from database with user profiles
    const { data: messages, error } = await supabase
      .from('session_messages')
      .select(`
        id,
        session_id,
        user_id,
        message_text,
        message_type,
        created_at,
        updated_at,
        profiles!session_messages_user_id_fkey (
          id,
          name,
          avatar_url,
          role
        )
      `)
      .eq('session_id', sessionIdentifier)
      .order('created_at', { ascending: true })
      .limit(limit);
    
    if (error) {
      console.error('❌ Database error fetching messages:', error);
      return res.json({
        success: false,
        error: 'Failed to fetch messages',
        messages: []
      });
    }
    
    console.log(`✅ Retrieved ${messages?.length || 0} messages for session`, sessionIdentifier);
    
    // Format messages with user info
    const formattedMessages = (messages || []).map(msg => ({
      id: msg.id,
      session_id: msg.session_id,
      user_id: msg.user_id,
      senderId: msg.user_id,
      senderName: msg.profiles?.name || 'Unknown User',
      senderRole: msg.profiles?.role || 'student',
      avatar: msg.profiles?.avatar_url,
      text: msg.message_text,
      message_text: msg.message_text,
      message_type: msg.message_type || 'text',
      timestamp: msg.created_at,
      created_at: msg.created_at,
      profiles: {
        id: msg.profiles?.id,
        name: msg.profiles?.name,
        avatar_url: msg.profiles?.avatar_url,
        role: msg.profiles?.role
      }
    }));
    
    res.json({
      success: true,
      messages: formattedMessages,
      count: formattedMessages.length,
      session_id: sessionIdentifier
    });
    
  } catch (error) {
    console.error('❌ Error getting session messages:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      messages: []
    });
  }
});

router.post('/send-message', async (req, res) => {
  try {
    const { 
      session_id, 
      meeting_id, 
      user_id, 
      message_text, 
      message_type = 'text',
      user_role = 'student' 
    } = req.body;
    
    console.log('📤 SENDING REAL MESSAGE:', {
      session_id,
      meeting_id,
      user_id,
      message_length: message_text?.length,
      message_type,
      user_role,
      timestamp: new Date().toISOString()
    });
    
    if (!message_text || (!session_id && !meeting_id) || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: session_id/meeting_id, user_id, message_text'
      });
    }
    
    // Clean message text
    const cleanedMessage = message_text.trim();
    if (cleanedMessage.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Message cannot be empty'
      });
    }
    
    let actualSessionId = session_id;
    
    // If using meeting_id, get the session ID
    if (!actualSessionId && meeting_id) {
      const { data: videoSession, error: sessionError } = await supabase
        .from('video_sessions')
        .select('id, meeting_id, teacher_id, class_id')
        .eq('meeting_id', meeting_id)
        .single();
      
      if (sessionError || !videoSession) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }
      
      actualSessionId = videoSession.id;
    }
    
    // Insert message into database
    const { data: newMessage, error: insertError } = await supabase
      .from('session_messages')
      .insert([{
        session_id: actualSessionId,
        user_id: user_id,
        message_text: cleanedMessage,
        message_type: message_type,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select(`
        id,
        session_id,
        user_id,
        message_text,
        message_type,
        created_at,
        profiles!session_messages_user_id_fkey (
          id,
          name,
          avatar_url,
          role
        )
      `)
      .single();
    
    if (insertError) {
      console.error('❌ Database error inserting message:', insertError);
      return res.status(500).json({
        success: false,
        error: 'Failed to save message to database'
      });
    }
    
    // Format the response
    const formattedMessage = {
      id: newMessage.id,
      session_id: newMessage.session_id,
      user_id: newMessage.user_id,
      senderId: newMessage.user_id,
      senderName: newMessage.profiles?.name || (user_role === 'teacher' ? 'Teacher' : 'Student'),
      senderRole: newMessage.profiles?.role || user_role,
      avatar: newMessage.profiles?.avatar_url,
      text: newMessage.message_text,
      message_text: newMessage.message_text,
      message_type: newMessage.message_type,
      timestamp: newMessage.created_at,
      created_at: newMessage.created_at,
      profiles: newMessage.profiles
    };
    
    console.log('✅ Message sent successfully:', {
      message_id: newMessage.id,
      session_id: actualSessionId,
      user_name: formattedMessage.senderName,
      message_type: formattedMessage.message_type
    });
    
    res.json({
      success: true,
      message: formattedMessage,
      session_id: actualSessionId
    });
    
  } catch (error) {
    console.error('❌ Error sending message:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== RECORDING ENDPOINTS ====================
router.post('/start-recording', async (req, res) => {
  try {
    const { session_id, user_id } = req.body;
    
    console.log('⏺️ STARTING RECORDING FOR:', { session_id, user_id });
    
    if (!session_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Session ID and User ID are required'
      });
    }
    
    // Check if user is teacher
    const { data: session } = await supabase
      .from('video_sessions')
      .select('teacher_id')
      .eq('id', session_id)
      .single();
    
    if (!session || session.teacher_id !== user_id) {
      return res.status(403).json({
        success: false,
        error: 'Only teacher can start recording'
      });
    }
    
    // Log recording in database
    const { data: recording, error } = await supabase
      .from('session_recordings')
      .insert([{
        session_id: session_id,
        started_by: user_id,
        start_time: new Date().toISOString(),
        status: 'recording'
      }])
      .select()
      .single();
    
    if (error) {
      console.error('❌ Database error starting recording:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to start recording'
      });
    }
    
    console.log('✅ Recording started:', session_id);
    
    res.json({
      success: true,
      message: 'Recording started',
      recording_id: recording.id,
      start_time: recording.start_time
    });
    
  } catch (error) {
    console.error('❌ Error starting recording:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start recording'
    });
  }
});

router.post('/stop-recording', async (req, res) => {
  try {
    const { session_id, user_id } = req.body;
    
    console.log('⏹️ STOPPING RECORDING FOR:', { session_id, user_id });
    
    if (!session_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Session ID and User ID are required'
      });
    }
    
    // Get active recording
    const { data: activeRecording } = await supabase
      .from('session_recordings')
      .select('*')
      .eq('session_id', session_id)
      .eq('started_by', user_id)
      .is('end_time', null)
      .eq('status', 'recording')
      .single();
    
    if (!activeRecording) {
      return res.status(404).json({
        success: false,
        error: 'No active recording found'
      });
    }
    
    // Calculate duration
    const startTime = new Date(activeRecording.start_time);
    const endTime = new Date();
    const durationMinutes = Math.round((endTime - startTime) / 60000);
    
    // Update recording
    const { error } = await supabase
      .from('session_recordings')
      .update({
        end_time: endTime.toISOString(),
        status: 'completed',
        duration_minutes: durationMinutes
      })
      .eq('id', activeRecording.id);
    
    if (error) {
      console.error('❌ Database error stopping recording:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to stop recording'
      });
    }
    
    console.log('✅ Recording stopped:', {
      session_id,
      duration_minutes: durationMinutes
    });
    
    res.json({
      success: true,
      message: 'Recording stopped',
      recording_id: activeRecording.id,
      end_time: endTime.toISOString(),
      duration_minutes: durationMinutes
    });
    
  } catch (error) {
    console.error('❌ Error stopping recording:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop recording'
    });
  }
});

// ==================== DEBUG & UTILITY ENDPOINTS ====================
router.get('/active-sessions', async (req, res) => {
  try {
    const memorySessions = sessionManager.getActiveSessions();
    const { data: dbSessions } = await supabase
      .from('video_sessions')
      .select(`
        *,
        classes (title, teacher_id, description)
      `)
      .eq('status', 'active')
      .order('started_at', { ascending: false });

    res.json({
      success: true,
      memory_sessions: memorySessions,
      database_sessions: dbSessions || [],
      memory_count: memorySessions.length,
      database_count: dbSessions?.length || 0
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
    participants_count: session.participants?.length || 0
  }));

  res.json({
    all_sessions: sessions,
    total_sessions: sessions.length,
    active_sessions: sessions.filter(s => s.status === 'active').length
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

// ==================== TOKEN GENERATION ENDPOINT ====================
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

// ==================== SESSION RECOVERY ====================
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

// ==================== GENERATE TOKEN ONLY ====================
router.post('/generate-token-only', async (req, res) => {
  try {
    const { channelName, uid, role = 'publisher' } = req.body;

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.status(500).json({
        success: false,
        error: 'Agora credentials not configured'
      });
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

    res.json({
      success: true,
      token,
      appId,
      channelName,
      uid,
      expirationTime
    });

  } catch (error) {
    console.error('❌ Token generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate token'
    });
  }
});

// ==================== FIND SESSIONS BY CLASS ====================
router.post('/find-class-sessions', async (req, res) => {
  try {
    const { class_id, student_id } = req.body;

    console.log('🔍 FINDING SESSIONS FOR CLASS:', { class_id, student_id });

    if (!class_id) {
      return res.status(400).json({
        success: false,
        error: 'Class ID is required'
      });
    }

    const results = [];

    // 1. Check memory sessions
    const memorySessions = sessionManager.getActiveSessions();
    const classMemorySessions = memorySessions.filter(s => s.class_id === class_id);
    
    classMemorySessions.forEach(session => {
      results.push({
        meeting_id: session.meeting_id,
        channel_name: session.channel_name,
        teacher_id: session.teacher_id,
        teacher_joined: session.teacher_joined,
        participant_count: session.participants?.length || 0,
        started_at: session.started_at,
        source: 'memory',
        is_dynamic_id: session.is_dynamic_id || false
      });
    });

    // 2. Check database sessions
    const { data: dbSessions, error } = await supabase
      .from('video_sessions')
      .select(`
        meeting_id,
        channel_name,
        teacher_id,
        status,
        started_at,
        is_dynamic_id,
        profiles!video_sessions_teacher_id_fkey (
          name,
          avatar_url
        )
      `)
      .eq('class_id', class_id)
      .eq('status', 'active')
      .is('ended_at', null)
      .order('started_at', { ascending: false });

    if (!error && dbSessions) {
      dbSessions.forEach(session => {
        // Avoid duplicates
        if (!results.find(r => r.meeting_id === session.meeting_id)) {
          results.push({
            meeting_id: session.meeting_id,
            channel_name: session.channel_name,
            teacher_id: session.teacher_id,
            teacher_name: session.profiles?.name,
            participant_count: 0,
            started_at: session.started_at,
            source: 'database',
            is_dynamic_id: session.is_dynamic_id || false
          });
        }
      });
    }

    console.log('✅ FOUND SESSIONS FOR CLASS:', {
      class_id,
      count: results.length,
      sessions: results.map(r => ({
        meeting_id: r.meeting_id,
        teacher: r.teacher_id,
        teacher_joined: r.teacher_joined,
        is_dynamic: r.is_dynamic_id
      }))
    });

    // Generate suggested meeting IDs
    const suggestedMeetingIds = [
      `class_${class_id}`, // Generic
      ...results.map(r => r.meeting_id), // Existing sessions
      // Teacher-specific patterns for dynamic IDs
      ...results
        .filter(r => r.is_dynamic_id)
        .map(r => {
          const match = r.meeting_id.match(/class_([^_]+)_teacher_([^_]+)/);
          if (match) {
            return `class_${match[1]}_teacher_${match[2]}`;
          }
          return null;
        })
        .filter(Boolean)
    ].filter((v, i, a) => a.indexOf(v) === i); // Remove duplicates

    res.json({
      success: true,
      class_id,
      sessions: results,
      count: results.length,
      suggested_meeting_ids: suggestedMeetingIds,
      has_sessions: results.length > 0,
      message: results.length > 0 
        ? `Found ${results.length} active session(s) for this class` 
        : 'No active sessions found for this class'
    });

  } catch (error) {
    console.error('❌ Error finding class sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      sessions: []
    });
  }
});

export default router;
