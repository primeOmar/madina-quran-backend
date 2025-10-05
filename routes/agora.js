// routes/agora.js (on your Render backend)
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

// Generate Agora Token endpoint
router.post('/generate-token', async (req, res) => {
  try {
    const { channelName, uid, role = 'publisher' } = req.body;

    if (!channelName) {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    
    if (!appId || !appCertificate) {
      return res.status(500).json({ error: 'Agora credentials not configured' });
    }

    // Token configuration
    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    // Determine role
    const userRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

    // Generate token
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid || 0,
      userRole,
      privilegeExpiredTs
    );

    res.json({
      token,
      appId: appId,
      channelName,
      uid: uid || 0,
      role: userRole,
      expiresAt: privilegeExpiredTs
    });

  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Get Agora config (for frontend)
router.get('/config', (req, res) => {
  res.json({
    appId: process.env.AGORA_APP_ID,
    tokenEnabled: !!process.env.AGORA_APP_CERTIFICATE
  });
});
