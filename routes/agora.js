import express from 'express';
import pkg from 'agora-access-token';
const { RtcTokenBuilder, RtcRole } = pkg;
import { supabase } from '../server.js';
import { strictLimiter, standardLimiter, veryStrictLimiter } from '../middleware/rateLimiter.js';
import { cacheMiddleware , clearCache} from '../middleware/cache.js';
const router = express.Router();

const hashUserIdToNumber = (uuid) => {
  if (!uuid) return Math.floor(Math.random() * 1000000);
  // Simple hashing algorithm to turn string UUID into a 32-bit integer
  let hash = 0;
  for (let i = 0; i < uuid.length; i++) {
    const char = uuid.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
};

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


restoreParticipants(meetingId, participants, agora_uids = {}) {
  const session = this.sessions.get(meetingId);
  if (!session) {
    console.warn(`⚠️ Cannot restore participants - session ${meetingId} not found`);
    return false;
  }
  
  // Merge existing participants with new ones
  const currentParticipants = new Set(session.participants || []);
  participants.forEach(participantId => {
    currentParticipants.add(participantId);
  });
  
  session.participants = Array.from(currentParticipants);
  
  // Merge Agora UIDs
  session.agora_uids = { ...session.agora_uids, ...agora_uids };
  
  console.log('🔄 Restored participants for session:', {
    meetingId,
    totalParticipants: session.participants.length,
    students: session.participants.filter(p => p !== session.teacher_id).length,
    agoraUids: Object.keys(session.agora_uids).length
  });
  
  return true;
}

getSessionParticipants(meetingId) {
  const session = this.sessions.get(meetingId);
  if (!session) return [];
  
  return {
    participants: session.participants || [],
    agora_uids: session.agora_uids || {},
    teacher_id: session.teacher_id,
    teacher_joined: session.teacher_joined || false
  };
}
}

const sessionManager = new SessionManager();

// ==================== UTILITY FUNCTIONS ====================
 function generateShortChannelName(classId, userId) {
        const shortClassId = classId.substring(0, 8);
        const shortUserId = userId.substring(0, 8);
        const timestamp = Date.now().toString(36).substring(0, 6);
        return `ch_${shortClassId}_${shortUserId}_${timestamp}`.substring(0, 64);
      }
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

// ============================================
// /start-session route
// ============================================

router.post('/start-session', veryStrictLimiter, async (req, res) => {
  try {
    const { class_id, user_id, requested_meeting_id, requested_channel_name } = req.body;
    
    console.log('🎯 TEACHER STARTING SESSION:', {
      class_id,
      user_id,
      timestamp: new Date().toISOString()
    });

    // ========== VERIFY AGORA CONFIGURATION ==========
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.status(500).json({
        success: false,
        error: 'Agora video service not configured',
        code: 'AGORA_CONFIG_MISSING'
      });
    }

    // ========== CHECK FOR EXISTING SESSION ==========
    let sessionData;
    let channelName;
    let meetingId;
    let agoraUid;
    
    const { data: existingSession } = await supabase
      .from('video_sessions')
      .select('*')
      .eq('class_id', class_id)
      .eq('status', 'active')
      .maybeSingle();

    // ✅ NEW: Get existing participants BEFORE processing
    let existingParticipants = [];
    if (existingSession) {
      const { data: participants } = await supabase
        .from('session_participants')
        .select('user_id, role, agora_uid, joined_at')
        .eq('session_id', existingSession.id)
        .eq('status', 'joined')
        .neq('user_id', user_id); // Exclude teacher from participants list
        
      existingParticipants = participants || [];
      
      console.log('👥 FOUND EXISTING PARTICIPANTS:', {
        count: existingParticipants.length,
        participants: existingParticipants.map(p => ({
          user_id: p.user_id,
          role: p.role,
          agora_uid: p.agora_uid
        }))
      });
    }

    if (existingSession) {
      // ✅ CRITICAL FIX: ALWAYS use existing channel from database
      sessionData = existingSession;
      channelName = existingSession.channel_name;  
      meetingId = existingSession.meeting_id;      
      
      console.log('♻️ REUSING EXISTING SESSION:', {
        meetingId,
        channel: channelName,  
        fromDatabase: true,
        existingParticipants: existingParticipants.length
      });

      // Get existing teacher UID from session manager
      const memorySession = sessionManager.getSession(existingSession.meeting_id);
      agoraUid = memorySession?.teacher_agora_uid || generateUniqueAgoraUid();
      
      console.log('🔑 Teacher UID:', {
        fromMemory: !!memorySession?.teacher_agora_uid,
        uid: agoraUid
      });

      // Update timestamp only
      await supabase
        .from('video_sessions')
        .update({
          last_activity: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        })
        .eq('id', existingSession.id);
      
    } else {
      // ✅ CREATE NEW SESSION - Generate channel name ONCE
      meetingId = requested_meeting_id || 
                  `class_${class_id.replace(/-/g, '_')}_teacher_${user_id.substring(0, 8)}`;
      
      // Generate channel name ONCE and save to database
      channelName = requested_channel_name || generateShortChannelName(class_id, user_id);
      
      agoraUid = generateUniqueAgoraUid();
      while (agoraUid === 0 || agoraUid === 1) {
        agoraUid = generateUniqueAgoraUid();
      }

      console.log('🆕 CREATING NEW SESSION:', {
        meetingId,
        channel: channelName, 
        newUid: agoraUid
      });

      const generateAccessCode = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
          code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
      };

      const accessCode = generateAccessCode();

      // Create new session in database with CONSISTENT channel name
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
        throw new Error(`Database error: ${createError.message}`);
      }

      sessionData = newSession;
      
      console.log('💾 Saved to database:', {
        meetingId: sessionData.meeting_id,
        channel: sessionData.channel_name  // ← Verify saved correctly
      });
    }

    // ========== CRITICAL VERIFICATION ==========
    console.log('🔍 PRE-TOKEN VERIFICATION:', {
      sessionDataFromDB: {
        meeting_id: sessionData.meeting_id,
        channel_name: sessionData.channel_name
      },
      variablesUsedForToken: {
        channelName: channelName,
        meetingId: meetingId
      },
      MUST_MATCH: sessionData.channel_name === channelName,
      willGenerateTokenFor: channelName
    });

    // ⚠️ CRITICAL: Ensure channelName matches database
    if (sessionData.channel_name !== channelName) {
      console.error('❌❌❌ CRITICAL MISMATCH DETECTED!', {
        dbChannel: sessionData.channel_name,
        variableChannel: channelName,
        fixing: 'Using DB channel'
      });
      channelName = sessionData.channel_name;  // ← Force use DB channel
    }

    // ========== GENERATE AGORA TOKEN ==========
    const expirationTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;

    console.log('🔑 Generating token for:', {
      channel: channelName,  
      uid: agoraUid,
      meeting_id: meetingId
    });

    let token;
    try {
      token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        appCertificate,
        channelName,    
        agoraUid,
        RtcRole.PUBLISHER,
        privilegeExpiredTs
      );

      if (!token || token.length < 100) {
        throw new Error('Invalid token generated');
      }

      console.log('✅ Token generated:', {
        tokenLength: token.length,
        forChannel: channelName,
        forUid: agoraUid
      });

    } catch (tokenGenError) {
      console.error('❌ Token generation failed:', tokenGenError);
      return res.status(500).json({
        success: false,
        error: 'Token generation failed',
        code: 'TOKEN_GENERATION_FAILED'
      });
    }

    // ========== CREATE/UPDATE SESSION IN MEMORY WITH PARTICIPANTS ==========
    // ✅ CRITICAL FIX: Include existing participants in memory session
    const participants = [user_id]; // Start with teacher
    const agora_uids = { [user_id]: agoraUid };
    
    // Add existing participants if any
    if (existingParticipants.length > 0) {
      existingParticipants.forEach(participant => {
        if (!participants.includes(participant.user_id)) {
          participants.push(participant.user_id);
        }
        if (participant.agora_uid) {
          agora_uids[participant.user_id] = participant.agora_uid;
        }
      });
    }

    const memorySession = sessionManager.createSession(sessionData.meeting_id, {
      id: sessionData.id,
      meeting_id: sessionData.meeting_id,
      class_id: sessionData.class_id,
      teacher_id: sessionData.teacher_id,
      status: 'active',
      started_at: sessionData.started_at,
      channel_name: channelName,
      access_code: sessionData.access_code,
      participants: participants, // ✅ Now includes existing students
      agora_uids: agora_uids,     // ✅ Now includes student Agora UIDs
      teacher_joined: true,
      teacher_agora_uid: agoraUid,
      db_session_id: sessionData.id,
      is_dynamic_id: sessionData.is_dynamic_id || false,
      // ✅ NEW: Track participant metadata for better debugging
      participants_meta: existingParticipants.reduce((acc, p) => {
        acc[p.user_id] = {
          role: p.role,
          joined_at: p.joined_at,
          agora_uid: p.agora_uid
        };
        return acc;
      }, {})
    });

    console.log('💾 Memory session created:', {
      meetingId: memorySession.meeting_id,
      channel: memorySession.channel_name,
      teacherUid: agoraUid,
      participantsCount: participants.length,
      students: participants.filter(p => p !== user_id).length,
      hasExistingParticipants: existingParticipants.length > 0
    });

    // ========== CLEAR CACHE ==========
    clearCache(`class-sessions:${class_id}`);
    clearCache(`participants:${meetingId}`);
    console.log('🧹 Cleared cache for:', {
      classSessions: `class-sessions:${class_id}`,
      participants: `participants:${meetingId}`
    });

    // ========== BUILD RESPONSE WITH PARTICIPANTS INFO ==========
    const response = {
      success: true,
      meetingId: sessionData.meeting_id,
      channel: channelName,          
      channelName: channelName,      
      accessCode: sessionData.access_code,
      token: token,
      appId: appId,
      uid: agoraUid,
      teacherId: user_id,
      session: {
        id: sessionData.id,
        meeting_id: sessionData.meeting_id,
        meetingId: sessionData.meeting_id,
        class_id: sessionData.class_id,
        teacher_id: sessionData.teacher_id,
        status: 'active',
        channel: channelName,        
        channel_name: channelName,   
        participants_count: participants.length,
        existing_participants_count: existingParticipants.length,
        teacher_joined: true,
        teacher_uid: agoraUid,
        is_dynamic_id: sessionData.is_dynamic_id || false,
        // ✅ NEW: Include existing participants in response
        existing_participants: existingParticipants.map(p => ({
          user_id: p.user_id,
          role: p.role,
          joined_at: p.joined_at
        }))
      },
      message: existingSession 
        ? `Rejoined existing session with ${existingParticipants.length} participants` 
        : 'Session started successfully',
      agoraConfig: {
        appIdConfigured: true,
        certificateConfigured: true,
        tokenGenerated: true,
        uidType: 'generated'
      },
      // ✅ NEW: Add session recovery info
      sessionRecoveryInfo: {
        restored_from_database: !!existingSession,
        existing_participants: existingParticipants.length,
        memory_session_created: true,
        channel_consistent: sessionData.channel_name === channelName
      }
    };

    // ========== FINAL VERIFICATION LOG ==========
    console.log('🔍 FINAL RESPONSE VERIFICATION:', {
      database: {
        channel: sessionData.channel_name,
        meeting_id: sessionData.meeting_id,
        participants_in_db: existingParticipants.length
      },
      memory_session: {
        participants: participants.length,
        students: participants.filter(p => p !== user_id).length,
        agora_uids_count: Object.keys(agora_uids).length
      },
      response_contains: {
        participants_count: response.session.participants_count,
        existing_participants_count: response.session.existing_participants_count,
        channel: response.channel,
        channelName: response.channelName,
        sessionChannel: response.session.channel_name
      },
      ALL_MATCH: 
        sessionData.channel_name === channelName &&
        channelName === response.channel &&
        channelName === response.channelName &&
        channelName === response.session.channel_name,
      status: sessionData.channel_name === channelName ? '✅ CONSISTENT' : '❌ MISMATCH',
      teacherRejoinFix: existingParticipants.length > 0 ? '✅ PARTICIPANTS RESTORED' : '✅ NO PARTICIPANTS TO RESTORE'
    });

    console.log('✅ TEACHER SESSION RESPONSE:', {
      meetingId: response.meetingId,
      channel: response.channel,
      uid: response.uid,
      tokenLength: response.token.length,
      participants: response.session.participants_count,
      existingParticipants: response.session.existing_participants_count
    });

    res.json(response);

  } catch (error) {
    console.error('❌ CRITICAL ERROR in /start-session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start session: ' + error.message,
      code: 'SESSION_START_FAILED'
    });
  }
});


// ==================== JOIN SESSION (PRODUCTION READY) ====================
router.post('/join-session', strictLimiter, async (req, res) => {
  try {
    const { meeting_id, user_id, user_type = 'student', is_screen_share = false } = req.body;
    
    // 1. Validate & Find Session
    const cleanMeetingId = meeting_id.toString().replace(/["']/g, '').trim();
    let session = sessionManager.getSession(cleanMeetingId);
    
    if (!session) {
      const { data: dbSession } = await supabase
        .from('video_sessions')
        .select('*, classes(title, teacher_id, id)')
        .eq('meeting_id', cleanMeetingId)
        .eq('status', 'active')
        .single();
      
      if (dbSession) {
        session = sessionManager.createSession(dbSession.meeting_id, {
          id: dbSession.id,
          class_id: dbSession.class_id,
          teacher_id: dbSession.teacher_id,
          channel_name: dbSession.channel_name,
          class_title: dbSession.classes?.title
        });
      }
    }

    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    // 2. Generate UID & Token (Using the Hash Fix)
    const isTeacher = (user_type === 'teacher' || user_id === session.teacher_id);
    const numericId = hashUserIdToNumber(user_id);
    const agoraUid = is_screen_share ? (numericId + 10000) : numericId;

    const token = RtcTokenBuilder.buildTokenWithUid(
      process.env.AGORA_APP_ID,
      process.env.AGORA_APP_CERTIFICATE,
      session.channel_name,
      agoraUid,
      RtcRole.PUBLISHER,
      Math.floor(Date.now() / 1000) + 3600
    );

    // 3. Update DB (Using SCHEMA columns: student_id and class_id)
    if (!is_screen_share) {
      sessionManager.addParticipant(session.meeting_id, user_id, agoraUid, isTeacher);
      
      await supabase.from('session_participants').upsert({
        session_id: session.id,
        student_id: user_id, 
        class_id: session.class_id, 
        role: isTeacher ? 'teacher' : 'student',
        status: 'joined',
        is_teacher: isTeacher
      }, { onConflict: 'session_id,student_id' });
    }

    // 4. Send Double-Style Response (Fixes "Missing Fields" error)
    return res.json({
      success: true,
      token,
      uid: agoraUid,
      appId: process.env.AGORA_APP_ID,      
      app_id: process.env.AGORA_APP_ID,    
      meetingId: session.meeting_id,
      meeting_id: session.meeting_id,
      channel: session.channel_name,
      channel_name: session.channel_name,
      class_title: session.class_title
    });

  } catch (error) {
    console.error('❌ Join Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});// ==================== GENERATE FRESH TOKEN ====================
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

// ==================== SYNC EXISTING PARTICIPANTS ====================
router.post('/sync-participants', strictLimiter, async (req, res) => {
  try {
    const { meeting_id, teacher_id } = req.body;
    
    console.log('🔄 SYNC PARTICIPANTS REQUEST:', { meeting_id, teacher_id });
    
    if (!meeting_id || !teacher_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and Teacher ID are required'
      });
    }
    
    // 1. Get session from database
    const { data: session } = await supabase
      .from('video_sessions')
      .select('id, teacher_id')
      .eq('meeting_id', meeting_id)
      .eq('status', 'active')
      .single();
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }
    
    // 2. Verify teacher
    if (session.teacher_id !== teacher_id) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to sync participants'
      });
    }
    
    // 3. Get all current participants
    const { data: participants } = await supabase
      .from('session_participants')
      .select('user_id, role, agora_uid, joined_at')
      .eq('session_id', session.id)
      .eq('status', 'joined')
      .neq('user_id', teacher_id); // Exclude teacher
    
    // 4. Update session manager
    if (participants && participants.length > 0) {
      const participantIds = participants.map(p => p.user_id);
      const agora_uids = {};
      
      participants.forEach(p => {
        if (p.agora_uid) {
          agora_uids[p.user_id] = p.agora_uid;
        }
      });
      
      sessionManager.restoreParticipants(meeting_id, participantIds, agora_uids);
    }
    
    // 5. Return sync info
    res.json({
      success: true,
      participants_synced: participants?.length || 0,
      participants: participants?.map(p => ({
        user_id: p.user_id,
        role: p.role,
        joined_at: p.joined_at
      })) || [],
      session: {
        meeting_id,
        teacher_id,
        total_participants: (participants?.length || 0) + 1 // +1 for teacher
      },
      message: participants?.length 
        ? `Synced ${participants.length} existing participants` 
        : 'No existing participants to sync'
    });
    
  } catch (error) {
    console.error('❌ Error syncing participants:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync participants'
    });
  }
});

// ==================== START SESSION (TEACHER)  ====================
// COMPLETE FIXED VERSION
const joinChannel = async (sessionData) => {
  try {
    const { channel, token, uid, appId } = sessionData;
    
    console.log('🔗 TEACHER: Joining channel with:', {
      channel,
      tokenLength: token?.length,
      appId,
      uid,
      hasToken: !!token,
      tokenStart: token?.substring(0, 20) + '...'
    });

    // VALIDATE TOKEN
    if (!token || token === 'demo_token' || token === 'null') {
      console.error('❌ No valid token provided!');
      throw new Error('Invalid token. Check backend token generation.');
    }

    // ❌ REMOVE THIS LINE - It doesn't exist in SDK NG:
    // await clientRef.current.init(appId);
    
    // ✅ CORRECT: Just join directly - SDK NG doesn't need init()
    const joinedUid = await clientRef.current.join(
      appId,
      channel,
      token,
      uid || null  // Use null instead of 0 to let Agora assign UID
    );
    
    console.log('✅ TEACHER: Successfully joined channel:', {
      channel,
      assignedUid: joinedUid,
      requestedUid: uid
    });
    
    // Create and publish tracks
    await createAndPublishTracks();

    setSessionState(prev => ({
      ...prev,
      isJoined: true
    }));

    // Start duration tracking
    startDurationTracking();

    // Setup event listeners
    setupAgoraEventListeners();

  } catch (error) {
    console.error('❌ TEACHER Join channel error:', error);
    
    // Enhanced error handling
    if (error.code === 'INVALID_PARAMS') {
      throw new Error('Invalid Agora parameters. Check App ID and token.');
    } else if (error.code === 'CAN_NOT_GET_GATEWAY_SERVER') {
      throw new Error('Cannot connect to Agora servers. Check your internet connection and firewall settings.');
    } else if (error.message?.includes('token')) {
      throw new Error('Token authentication failed. The token may be expired or invalid.');
    } else {
      throw new Error(`Join failed: ${error.message || error.code || 'Unknown error'}`);
    }
  }
};
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

      // ========== CLEAR CACHE ==========
      clearCache(`class-sessions:${dbSession.class_id}`);
      clearCache(`participants:${meeting_id}`);
      console.log('🧹 Cleared cache for ended session:', {
        classSessions: `class-sessions:${dbSession.class_id}`,
        participants: `participants:${meeting_id}`
      });

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

    // ========== CLEAR CACHE ==========
    clearCache(`class-sessions:${session.class_id}`);
    clearCache(`participants:${meeting_id}`);
    console.log('🧹 Cleared cache for ended session:', {
      classSessions: `class-sessions:${session.class_id}`,
      participants: `participants:${meeting_id}`
    });

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

router.get('/session-status/:meetingId', 
  strictLimiter,
  async (req, res) => {
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

router.get('/session-by-class/:classId', 
  strictLimiter,  
  cacheMiddleware(10, (req) => `session-by-class:${req.params.classId}`),  
  async (req, res) => {
  try {
    const { classId } = req.params;
    
    console.log('🔍 Finding session for class:', classId);

    // Find active session for this class
    const { data: session, error } = await supabase
      .from('video_sessions')
      .select(`
        *,
        classes (
          title,
          teacher_id
        )
      `)
      .eq('class_id', classId)
      .eq('status', 'active')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('❌ Database error:', error);
      return res.status(500).json({
        success: false,
        error: 'Database error: ' + error.message
      });
    }

    if (!session) {
      console.log('⚠️ No active session found for class:', classId);
      return res.status(404).json({
        success: false,
        error: 'No active session found',
        exists: false,
        isActive: false
      });
    }

    console.log('✅ Found active session:', {
      meetingId: session.meeting_id,
      channel: session.channel_name,
      status: session.status,
      teacher: session.teacher_id
    });

    res.json({
      success: true,
      exists: true,
      isActive: true,
      session: {
        id: session.id,
        meeting_id: session.meeting_id,
        class_id: session.class_id,
        teacher_id: session.teacher_id,
        channel_name: session.channel_name,
        status: session.status,
        started_at: session.started_at,
        class_title: session.classes?.title
      },
      meetingId: session.meeting_id,
      channel: session.channel_name,
      teacher_id: session.teacher_id
    });

  } catch (error) {
    console.error('❌ Error in session-by-class:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      exists: false,
      isActive: false
    });
  }
});

router.get('/find-session/:classId',
  strictLimiter,
  cacheMiddleware(10, (req) => `find-session:${req.params.classId}`),
  async (req, res) => {
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
    
    console.log('👥 Fetching participants for meeting:', meeting_id);
    
    if (!meeting_id) {
      return res.json({
        success: true,
        participants: []
      });
    }
    
    // Get session info first to identify teacher
    const { data: session } = await supabase
      .from('video_sessions')
      .select('id, teacher_id, class_id')
      .eq('meeting_id', meeting_id)
      .single();
    
    if (!session) {
      return res.json({
        success: true,
        participants: []
      });
    }
    
    // Get participants from database with full profile data
   const { data: participants, error } = await supabase
  .from('session_participants')
  .select(`
    *,
    profiles:student_id (
      id,
      name,
      email
    )
  `)
  .eq('class_id', session.class_id)
      .eq('status', 'joined')
      .order('joined_at', { ascending: true });
    
    if (error) {
      console.error('Database error:', error);
      return res.json({
        success: true,
        participants: []
      });
    }
    
    // Format participants with correct role detection
    const formattedParticipants = (participants || []).map(p => {
      const isTeacher = p.user_id === session.teacher_id;
      const name = p.profiles?.name || (isTeacher ? 'Teacher' : 'Student');
      
      return {
        user_id: p.user_id,
        agora_uid: p.agora_uid,
        role: isTeacher ? 'teacher' : 'student',
        is_teacher: isTeacher,
        name: name,
        display_name: name,
        email: p.profiles?.email,
        avatar_url: p.profiles?.avatar_url,
        joined_at: p.joined_at,
        status: p.status,
        profile: {
          id: p.profiles?.id,
          name: name,
          role: isTeacher ? 'teacher' : 'student',
          avatar_url: p.profiles?.avatar_url
        }
      };
    });
    
    console.log(`✅ Found ${formattedParticipants.length} participants:`, {
      teachers: formattedParticipants.filter(p => p.is_teacher).map(p => p.name),
      students: formattedParticipants.filter(p => !p.is_teacher).map(p => p.name)
    });
    
    res.json({
      success: true,
      participants: formattedParticipants,
      count: formattedParticipants.length,
      teacher_id: session.teacher_id,
      teacher_uid: formattedParticipants.find(p => p.is_teacher)?.agora_uid
    });

  } catch (error) {
    console.error('❌ Error getting participants:', error);
    res.json({
      success: true,
      participants: [],
      count: 0
    });
  }
});

router.post('/get-participant-profiles', async (req, res) => {
  try {
    const { meeting_id, agora_uids } = req.body;
    
    console.log('👥 Getting participant profiles:', {
      meeting_id,
      uids: agora_uids
    });
    
    if (!meeting_id || !agora_uids || !Array.isArray(agora_uids)) {
      return res.status(400).json({
        success: false,
        error: 'meeting_id and agora_uids array required'
      });
    }
    
    // Get session first
    const { data: session } = await supabase
      .from('video_sessions')
      .select('id, teacher_id')
      .eq('meeting_id', meeting_id)
      .single();
    
    if (!session) {
      return res.json({
        success: false,
        profiles: []
      });
    }
    
    // Get all participants for this session with their profiles
    const { data: participants, error } = await supabase
      .from('session_participants')
      .select(`
        *,
        profiles:user_id (
          id,
          name,
          email,
          role
        )
      `)
      .eq('session_id', session.id)
      .in('agora_uid', agora_uids)
      .eq('status', 'joined');
    
    if (error) {
      console.error('Database error:', error);
      return res.json({
        success: false,
        profiles: []
      });
    }
    
    // Format profiles with proper role detection
    const profiles = (participants || []).map(p => ({
      user_id: p.user_id,
      agora_uid: p.agora_uid,
      name: p.profiles?.name || (p.user_id === session.teacher_id ? 'Teacher' : 'Student'),
      display_name: p.profiles?.name || (p.user_id === session.teacher_id ? 'Teacher' : 'Student'),
      email: p.profiles?.email,
      role: p.user_id === session.teacher_id ? 'teacher' : 'student',
      is_teacher: p.user_id === session.teacher_id,
      joined_at: p.joined_at
    }));
    
    console.log('✅ Found profiles:', {
      count: profiles.length,
      teacher: profiles.find(p => p.is_teacher)?.name,
      students: profiles.filter(p => !p.is_teacher).map(p => p.name)
    });
    
    res.json({
      success: true,
      profiles,
      count: profiles.length
    });
    
  } catch (error) {
    console.error('❌ Error getting profiles:', error);
    res.json({
      success: false,
      profiles: []
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
router.post('/session-messages',
  strictLimiter,
  cacheMiddleware(5, (req) => `messages:${req.body.sessionId}`),
  async (req, res) => {
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
      .from('video_session_messages')
      .select(`
        id,
        session_id,
        user_id,
        message_text,
        message_type,
        created_at,
        profiles!video_session_messages_user_id_fkey (
          id,
          name,
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
      .from('video_session_messages')
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
        profiles!video_session_messages_user_id_fkey (
          id,
          name,
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


router.post('/generate-token', standardLimiter, async (req, res) => {
  try {
    const { channelName, uid, role } = req.body;

    if (!channelName) {
      return res.status(400).json({ error: 'channelName is required' });
    }

    let finalUid;
    if (typeof uid === 'number') {
      finalUid = uid;
    } else {
      finalUid = hashUserIdToNumber(uid);
    }
    // ---------------------

    const privilegeLowTimeInSeconds = 3600; 
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + privilegeLowTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      process.env.AGORA_APP_ID,
      process.env.AGORA_APP_CERTIFICATE,
      channelName,
      finalUid, // Use the processed UID
      role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
      privilegeExpiredTs
    );

    return res.json({ 
      token, 
      uid: finalUid,
      channelName 
    });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
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
router.post('/find-class-sessions',
  strictLimiter,
  cacheMiddleware(15, (req) => `class-sessions:${req.body.class_id}`),
  async (req, res) => {
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
router.get('/participants/:meetingId', 
  strictLimiter, 
  cacheMiddleware(10, (req) => `participants:${req.params.meetingId}`),
  async (req, res) => {
    const { meetingId } = req.params;
    
    try {
      console.log('📡 API: Fetching participants for:', meetingId);
      
      // 1. Get session from memory first
      const session = sessionManager.getSession(meetingId);
      if (!session) {
        console.warn('⚠️ API: Session not found in memory:', meetingId);
        return res.status(404).json({ 
          success: false, 
          error: 'Session not found',
          participants: [] 
        });
      }

      // 2. Fetch from Database using the 'student_id' relationship (Matches your Schema)
      const { data: dbParticipants, error: dbError } = await supabase
        .from('session_participants')
        .select(`
          *,
          profiles:student_id (
            id,
            name,
            avatar_url,
            role
          )
        `)
        .eq('session_id', session.id)
        .eq('status', 'joined');

      // 3. Hybrid Logic: If DB fails or is empty, use memory cache as fallback
      // This prevents the UI from showing "Empty" if the DB hasn't updated yet.
      if (dbError || !dbParticipants || dbParticipants.length === 0) {
        if (dbError) console.error('❌ DB Error, falling back to memory:', dbError.message);
        
        const memoryParticipants = (session.participants || []).map(uid => {
          const isTeacher = uid === session.teacher_id;
          return {
            user_id: uid,
            agora_uid: session.agora_uids[uid],
            name: isTeacher ? 'Teacher' : 'Student',
            role: isTeacher ? 'teacher' : 'student',
            is_teacher: isTeacher,
            avatar_url: null
          };
        });

        return res.json({
          success: true,
          source: 'memory_fallback',
          participants: memoryParticipants,
          count: memoryParticipants.length
        });
      }

      // 4. Format the DB results for the Frontend
      const formattedParticipants = dbParticipants.map(p => {
        // Teacher detection: check flag OR check if user_id matches session teacher
        const isTeacher = p.is_teacher || p.student_id === session.teacher_id;
        
        return {
          user_id: p.student_id,
          agora_uid: p.agora_uid || session.agora_uids[p.student_id],
          name: p.profiles?.name || (isTeacher ? 'Teacher' : 'Student'),
          display_name: p.profiles?.name || (isTeacher ? 'Teacher' : 'Student'),
          role: isTeacher ? 'teacher' : 'student',
          is_teacher: isTeacher,
          avatar_url: p.profiles?.avatar_url,
          joined_at: p.joined_at
        };
      });

      console.log(`✅ API: Returning ${formattedParticipants.length} participants`);

      return res.json({
        success: true,
        source: 'database',
        participants: formattedParticipants,
        count: formattedParticipants.length,
        teacher_id: session.teacher_id
      });

    } catch (error) {
      console.error('❌ CRITICAL: Participant Fetch Error:', error.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Internal server error',
        participants: [] 
      });
    }
});
export default router;
