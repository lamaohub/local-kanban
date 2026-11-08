import { VOICE_TEXT_MAX, sayVoice, voiceState, warmVoice } from '../voice.js';

const REFUSED = { 'not-installed': 409, busy: 429, failed: 503 };
export default async function voiceRoutes(app) {
  app.get('/api/voice', () => voiceState());
  app.post('/api/voice/warm', async (req, reply) => {
    try { await warmVoice(); return voiceState(); } catch (e) { return reply.code(REFUSED[e.reason] || 503).send({ error: e.message, reason: e.reason || 'failed' }); }
  });
  app.post('/api/voice', async (req, reply) => {
    const text = req.body?.text;
    const speaker = req.body?.speaker;
    if (typeof text !== 'string' || !text.trim() || text.length > VOICE_TEXT_MAX || text.includes('\0')) {
      return reply.code(400).send({ error: `text: words to say, at most ${VOICE_TEXT_MAX} characters`, field: 'text' });
    }
    if (typeof speaker !== 'string' || !voiceState().speakers.includes(speaker)) return reply.code(400).send({ error: 'speaker: one of the voice\'s speakers', field: 'speaker' });
    try {
      const wav = await sayVoice(text, speaker);
      return reply.header('content-type', 'audio/wav').header('cache-control', 'no-store').send(wav);
    } catch (e) {
      return reply.code(REFUSED[e.reason] || 503).send({ error: e.message, reason: e.reason || 'failed' });
    }
  });
}
