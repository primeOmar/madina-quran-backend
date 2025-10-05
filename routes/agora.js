// routes/agora.js - Optimized for reliability
const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

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
    
    if (!appId || !appCertificate) {
      return res.status(500).json({ 
        success: false,
        error: 'Video service temporarily unavailable'
      });
    }

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

    res.json({
      success: true,
      token,
      appId,
      channelName,
      uid: uid || 0,
      expiresAt: privilegeExpiredTs
    });

  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to generate token',
      fallback: true // Signal frontend to use fallback
    });
  }
});

// Health check for video service
router.get('/health', (req, res) => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  
  res.json({
    status: 'healthy',
    videoEnabled: !!(appId && appCertificate),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
