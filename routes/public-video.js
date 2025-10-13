import express from 'express';
import { supabase, clearCache } from '../server.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiting for public endpoints
const videoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per window per IP
  message: { error: 'Too many video session requests' }
});

// Input validation middleware
const validateVideoSession = (req, res, next) => {
  const { class_id, meeting_id } = req.body;
  
  if (!class_id || !meeting_id) {
    return res.status(400).json({ error: 'Class ID and meeting ID are required' });
  }
  
  // Validate UUID format for class_id
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(class_id)) {
    return res.status(400).json({ error: 'Invalid class ID format' });
  }
  
  // Validate meeting_id format
  if (meeting_id.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(meeting_id)) {
    return res.status(400).json({ error: 'Invalid meeting ID format' });
  }
  
  next();
};

// Public video session endpoints with security
router.post('/start', videoLimiter, validateVideoSession, async (req, res) => {
  try {
    const { class_id, meeting_id, agenda } = req.body;

    console.log('🎥 Creating public video session:', { class_id, meeting_id });

    // Verify class exists and is valid
    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('id, status')
      .eq('id', class_id)
      .eq('status', 'scheduled')
      .single();

    if (classError || !classData) {
      return res.status(400).json({ 
        error: 'Class not found or not scheduled',
        class_id 
      });
    }

    // Check if session already exists
    const { data: existingSession } = await supabase
      .from('video_sessions')
      .select('id')
      .eq('meeting_id', meeting_id)
      .single();

    if (existingSession) {
      return res.status(409).json({ 
        error: 'Video session already exists',
        meeting_id 
      });
    }

    // Create video session
    const { data, error } = await supabase
      .from('video_sessions')
      .insert([
        {
          class_id,
          meeting_id,
          agenda: agenda || 'Quran Class Session',
          status: 'active',
          started_at: new Date().toISOString(),
          channel_name: `class_${class_id}`,
          // Additional security fields
          ip_address: req.ip,
          user_agent: req.get('User-Agent')?.substring(0, 200)
        }
      ])
      .select(`
        id,
        meeting_id,
        class_id,
        status,
        started_at,
        channel_name,
        agenda
      `)
      .single();

    if (error) {
      console.error('❌ Error creating public video session:', error);
      return res.status(400).json({ error: 'Failed to create session' });
    }

    // Clear cache for live sessions
    clearCache('liveSessions');

    console.log('✅ Public video session created:', data.meeting_id);
    
    res.status(201).json({
      ...data,
      success: true,
      message: 'Video session started successfully'
    });
  } catch (error) {
    console.error('❌ Error starting public video session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check for public video service
router.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'public-video',
    timestamp: new Date().toISOString()
  });
});

export default router;
