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

function generateUniqueAgoraUid() {
  // Agora UID range: 1 to 4294967295
  // Avoid UID 1 as it might be problematic
  let uid;
  do {
    uid = Math.floor(Math.random() * 100000) + 1000; // 1000-100999
  } while (uid === 1);
  return uid;
}

// ==================== START SESSION (TEACHER) ====================
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

    // Verify class exists and teacher is authorized
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

    // Generate valid meeting ID and channel name
    const meetingId = generateValidMeetingId(class_id);
    const channelName = generateValidChannelName(class_id, user_id);

    console.log('📝 Generated valid session details:', { meetingId, channelName });

    // Create video session in database
    const { data: dbSession, error: dbError } = await supabase
      .from('video_sessions')
      .insert([{
        meeting_id: meetingId,
        class_id: class_id,
        teacher_id: user_id,
        channel_name: channelName,
        status: 'active',
        started_at: new Date().toISOString(),
        agenda: `Live class: ${classData.title}`
      }])
      .select()
      .single();

    if (dbError) {
      console.error('❌ Database insertion failed:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create session in database'
      });
    }

    // Update class status to active
    await supabase
      .from('classes')
      .update({ status: 'active' })
      .eq('id', class_id);

    // Send notifications to enrolled students
    let notifiedStudents = 0;
    try {
      const { data: enrollments } = await supabase
        .from('students_classes')
        .select('student_id')
        .eq('class_id', class_id);

      if (enrollments && enrollments.length > 0) {
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
                action_url: `/join-class/${meetingId}`
              },
              created_at: new Date().toISOString()
            }]);

          if (!notifError) notifiedStudents++;
        });

        await Promise.allSettled(notificationPromises);
        console.log(`✅ Sent notifications to ${notifiedStudents} students`);
      }
    } catch (notifError) {
      console.error('❌ Notification sending failed:', notifError);
    }

    // ========== GENERATE TEACHER TOKEN IMMEDIATELY ==========
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.status(500).json({
        success: false,
        error: 'Video service not configured'
      });
    }

    // Generate unique Agora UID for teacher
    const teacherUid = generateUniqueAgoraUid();
    
    const expirationTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      teacherUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    // Create session in memory WITH TEACHER ALREADY JOINED
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
      agora_uids: {},
      teacher_joined: true,
      teacher_agora_uid: teacherUid
    };

    sessionManager.createSession(meetingId, sessionData);
    
    // Add teacher to participants in session manager
    sessionManager.addParticipant(meetingId, user_id, teacherUid, true);

    console.log('✅ TEACHER SESSION STARTED SUCCESSFULLY:', {
      meetingId,
      channelName,
      teacher: user_id,
      teacherUid,
      tokenLength: token?.length
    });

    res.json({
      success: true,
      meeting_id: meetingId,
      channel: channelName,
      token: token,
      app_id: appId,
      uid: teacherUid,
      user_type: 'teacher',
      is_teacher: true,
      teacher_id: user_id,
      class_title: classData.title,
      db_session_created: true,
      students_notified: notifiedStudents
    });

  } catch (error) {
    console.error('❌ Error starting video session:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// ==================== UNIFIED JOIN SESSION (NO VALIDATION FOR STUDENTS) ====================
router.post('/join-session', async (req, res) => {
  try {
    const { 
      meeting_id, 
      user_id, 
      user_type = 'teacher'
    } = req.body;

    console.log('🔗 JOIN-SESSION REQUEST (NO VALIDATION):', { 
      meeting_id, 
      user_id, 
      user_type
    });

    if (!meeting_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Meeting ID and User ID are required',
        code: 'MISSING_PARAMS'
      });
    }

    // Clean meeting_id
    const cleanMeetingId = meeting_id.replace(/["']/g, '');
    
    // Get session from memory or database
    let session = sessionManager.getSession(cleanMeetingId);
    
    if (!session) {
      console.log('🔄 Session not in memory, checking database...');
      
      const { data: dbSession, error: dbError } = await supabase
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
        .single();

      if (dbError || !dbSession) {
        return res.status(404).json({
          success: false,
          error: 'Active session not found. Teacher needs to start the session first.',
          code: 'SESSION_NOT_FOUND'
        });
      }

      // Restore session from database
      session = sessionManager.createSession(cleanMeetingId, {
        id: dbSession.id,
        meeting_id: cleanMeetingId,
        class_id: dbSession.class_id,
        teacher_id: dbSession.teacher_id,
        status: 'active',
        started_at: dbSession.started_at,
        channel_name: dbSession.channel_name,
        class_title: dbSession.classes?.title,
        participants: [],
        db_session_id: dbSession.id,
        agora_uids: {},
        teacher_joined: false
      });
    }

    const isTeacher = user_type === 'teacher';
    
    // ========== TEACHER VALIDATION ONLY ==========
    if (isTeacher) {
      if (session.teacher_id !== user_id) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to join this session as teacher.',
          code: 'TEACHER_AUTH_FAILED'
        });
      }
    } 
    // ========== STUDENT: NO VALIDATION REQUIRED ==========
    // Any student can join with the meeting ID
    else {
      console.log('🎓 Student joining - NO ENROLLMENT CHECK:', {
        user_id,
        meeting_id: cleanMeetingId,
        teacher_joined: session.teacher_joined,
        teacher_present: session.teacher_joined,
        welcome_message: 'Any student can join with the meeting link'
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

    // Generate Agora UID
    let agoraUid;
    if (isTeacher) {
      // Teacher gets unique UID
      agoraUid = generateUniqueAgoraUid();
    } else {
      // Student gets unique UID
      do {
        agoraUid = generateUniqueAgoraUid();
      } while (agoraUid === session.teacher_agora_uid || 
               Object.values(session.agora_uids || {}).includes(agoraUid));
    }

    const expirationTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expirationTime;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      session.channel_name,
      agoraUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    // Add participant to session
    sessionManager.addParticipant(cleanMeetingId, user_id, agoraUid, isTeacher);

    // Log participant in database (optional - for tracking)
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
          // Mark as guest if you want to track unenrolled students
          is_guest: !isTeacher // You might want to add enrollment check here if tracking
        }, {
          onConflict: 'session_id,user_id'
        });
    } catch (dbError) {
      console.warn('⚠️ Database logging failed (not critical):', dbError.message);
    }

    // ========== BUILD RESPONSE ==========
    const response = {
      success: true,
      meeting_id: cleanMeetingId,
      channel: session.channel_name,
      token: token,
      app_id: appId,
      uid: agoraUid,
      user_type: isTeacher ? 'teacher' : 'student',
      is_teacher: isTeacher,
      teacher_present: session.teacher_joined,
      welcome_message: isTeacher ? 'Welcome Teacher!' : 'Welcome Student! You can join the call even without camera/mic permissions.',
      session: {
        id: session.id,
        meeting_id: cleanMeetingId,
        class_id: session.class_id,
        teacher_id: session.teacher_id,
        status: session.status,
        class_title: session.class_title,
        channel_name: session.channel_name,
        participants_count: sessionManager.getParticipantCount(cleanMeetingId)
      }
    };

    // Optional: Check enrollment for informational purposes (not for blocking)
    if (!isTeacher) {
      try {
        const { data: enrollment } = await supabase
          .from('students_classes')
          .select('*')
          .eq('class_id', session.class_id)
          .eq('student_id', user_id)
          .single();
        
        response.enrolled = !!enrollment;
        response.is_guest = !enrollment; // Track if guest student
      } catch (e) {
        response.enrolled = false;
        response.is_guest = true;
      }
    }

    console.log('✅ JOIN SUCCESSFUL (NO VALIDATION):', {
      meeting_id: cleanMeetingId,
      user_id,
      user_type,
      agora_uid: agoraUid,
      teacher_present: session.teacher_joined,
      message: 'Student joined without enrollment validation'
    });

    res.json(response);

  } catch (error) {
    console.error('❌ Error in join-session:', error);
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
    const session = sessionManager.getSession(meetingId);

    if (!session) {
      // Check database
      const { data: dbSession } = await supabase
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

      if (!dbSession) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      return res.json({
        success: true,
        session: {
          meeting_id: dbSession.meeting_id,
          class_id: dbSession.class_id,
          teacher_id: dbSession.teacher_id,
          status: dbSession.status,
          channel_name: dbSession.channel_name,
          started_at: dbSession.started_at,
          class_title: dbSession.classes?.title
        }
      });
    }

    res.json({
      success: true,
      session: {
        meeting_id: meetingId,
        class_id: session.class_id,
        teacher_id: session.teacher_id,
        status: session.status,
        channel_name: session.channel_name,
        started_at: session.started_at,
        class_title: session.class_title,
        participants: session.participants || [],
        teacher_joined: session.teacher_joined
      }
    });

  } catch (error) {
    console.error('❌ Error getting session info:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

router.get('/session-by-class/:classId', async (req, res) => {
  try {
    const { classId } = req.params;
    
    // Check memory sessions
    const memorySessions = sessionManager.getActiveSessions();
    const memorySession = memorySessions.find(s => s.class_id === classId);
    
    if (memorySession) {
      return res.json({
        success: true,
        session: {
          meeting_id: memorySession.meeting_id,
          class_id: memorySession.class_id,
          teacher_id: memorySession.teacher_id,
          status: memorySession.status,
          channel_name: memorySession.channel_name,
          started_at: memorySession.started_at,
          class_title: memorySession.class_title,
          participants: memorySession.participants || []
        },
        exists: true,
        isActive: true
      });
    }

    // Check database
    const { data: dbSession } = await supabase
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
      .single();

    if (!dbSession) {
      return res.json({
        success: true,
        exists: false,
        isActive: false,
        error: 'No active session found for this class'
      });
    }

    // Restore to memory
    sessionManager.createSession(dbSession.meeting_id, {
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

    res.json({
      success: true,
      session: {
        meeting_id: dbSession.meeting_id,
        class_id: dbSession.class_id,
        teacher_id: dbSession.teacher_id,
        status: dbSession.status,
        channel_name: dbSession.channel_name,
        started_at: dbSession.started_at,
        class_title: dbSession.classes?.title,
        participants: [dbSession.teacher_id]
      },
      exists: true,
      isActive: true,
      restored: true
    });

  } catch (error) {
    console.error('❌ Error finding session by class:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
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
        .select('id, meeting_id, teacher_id')
        .eq('meeting_id', meeting_id)
        .single();
      
      if (sessionError || !videoSession) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }
      
      actualSessionId = videoSession.id;
      
      // Verify user is part of this session (teacher or enrolled student)
      if (user_id !== videoSession.teacher_id) {
        const { data: enrollment } = await supabase
          .from('students_classes')
          .select('student_id')
          .eq('class_id', (await supabase
            .from('video_sessions')
            .select('class_id')
            .eq('id', actualSessionId)
            .single()
          )?.data?.class_id)
          .eq('student_id', user_id)
          .single();
        
        if (!enrollment) {
          return res.status(403).json({
            success: false,
            error: 'You are not enrolled in this class'
          });
        }
      }
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

export default router;
