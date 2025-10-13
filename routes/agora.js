
import express from 'express';
import pkg from 'agora-access-token'; 
const { RtcTokenBuilder, RtcRole } = pkg; 
import { supabase } from '../server.js';

const router = express.Router();

// Fast token generation with timeout
router.post('/generate-token', async (req, res) => {
  // Set timeout to prevent hanging
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
    
    // ✅ BETTER VALIDATION - Check if environment variables exist
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

    console.log('🔐 Generating token with App ID:', appId ? '***' + appId.slice(-4) : 'UNDEFINED');

    // Fast token generation
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

    // ✅ CRITICAL FIX: Return the exact structure frontend expects
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

router.post('/end', async (req, res) => {
  try {
    const { meeting_id } = req.body;
    
    if (!meeting_id) {
      return res.status(400).json({ error: 'Meeting ID is required' });
    }

    console.log('🛑 Ending video session in database:', meeting_id);

    // Update session status in database
    const { data, error } = await supabase
      .from('video_sessions')
      .update({ 
        status: 'ended', 
        ended_at: new Date().toISOString() 
      })
      .eq('meeting_id', meeting_id);

    if (error) {
      console.error('❌ Database error ending session:', error);
      return res.status(500).json({ error: 'Database update failed' });
    }

    console.log('✅ Database session ended successfully');
    res.json({ 
      success: true, 
      message: 'Session ended in database',
      meeting_id: meeting_id
    });

  } catch (error) {
    console.error('❌ End session error:', error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Health check for video service - ENHANCED
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
    // For debugging - don't expose full values in production
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
