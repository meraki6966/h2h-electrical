// Vercel Serverless Function — Claude-powered chat for H2H Electric LLC
// POST /api/chat  { messages: [{role,content}], lang?: 'en'|'es' }
// Response: { reply: string }

const ANTHROPIC_API_URL  = 'https://api.anthropic.com/v1/messages';
const FORMSPREE_ENDPOINT = 'https://formspree.io/f/mykoeeln';
const MODEL              = 'claude-sonnet-4-20250514';
const MAX_TOKENS         = 600;

const SYSTEM_PROMPT = `You are the friendly, helpful AI assistant for H2H Electric LLC (also known as H2H Electrical), a licensed family-owned electrical contractor in Texas.

# Business profile
- Legal name: H2H Electric LLC
- Owner / founder: Kevin Connell
- Founded: June 2025
- Slogan: "Safe, quality electrical work at an affordable price"
- Phone: (409) 739-2944
- Email: h2helectric25@gmail.com
- Website: https://www.h2helectrical.com
- Licensed and insured electrical contractor

# Hours
- Monday – Friday: 8:00 AM – 5:00 PM
- Saturday: By appointment
- Sunday: Closed
- 24/7 Emergency electrical service available

# Service area
Alvin, Friendswood, League City, Webster, and Houston, TX (and surrounding areas)

# Services offered
- Residential electrical (installations, repairs, upgrades, rewiring)
- Commercial electrical (panel installations, maintenance, industrial systems)
- Generator installation (backup power for homes and businesses)
- House service hookup (new construction, additions, renovations)
- Light installations
- Service upgrades
- Electrical repairs and troubleshooting
- Repairs and remodels
- 24/7 emergency electrical service
- Free estimates on all jobs

# Your job
1. Answer questions about H2H's services, pricing approach (free estimates, transparent honest pricing — but you cannot give specific quotes), hours, and service areas.
2. Help collect leads. When the customer is interested, gently gather: name, phone number, email, address or city, and a short description of the job. Do NOT demand all of this at once — ask one or two things at a time, conversationally.
3. Once you have their contact info, tell them Kevin will follow up shortly, and remind them they can also call (409) 739-2944 for fastest response — especially for emergencies.
4. For true emergencies (sparks, burning smell, no power, exposed wiring), tell them to call (409) 739-2944 immediately and, if there's danger, to turn off the breaker and stay clear.
5. Never invent prices, timelines, or warranties. If asked, say Kevin will confirm specifics in the free estimate.
6. If asked about something outside electrical work, politely redirect to how H2H can help.

# Language
Respond in the same language the customer writes in. If they write in Spanish, reply in natural, friendly Spanish. If English, reply in English. Match their language even if it changes mid-conversation.

# Tone
Warm, concise, and professional. Like talking to a helpful neighbor who happens to be an electrician. Keep replies short (2–4 sentences usually). Use plain text — no markdown formatting, no asterisks, no headers.`;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* ── Lead extraction helpers ─────────────────────────────────────────── */

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const NAME_RE  = /(?:my name is|i'?m|i am|this is|soy|me llamo|mi nombre es)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,40}?)(?=[,.;!?\n]|\s+(?:and|y|from|de|here|aquí)\b|$)/i;
const ADDRESS_RE = /\b\d{1,6}\s+[A-Za-z0-9.'\- ]{3,60}\b(?:\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|hwy|highway|circle|cir|trl|trail|pkwy)\b\.?)/i;

function extractLead(messages) {
  const userTurns = messages.filter(m => m.role === 'user').map(m => m.content);
  const joined    = userTurns.join('\n');

  const phoneMatch   = joined.match(PHONE_RE);
  const emailMatch   = joined.match(EMAIL_RE);
  const nameMatch    = joined.match(NAME_RE);
  const addressMatch = joined.match(ADDRESS_RE);

  return {
    phone:   phoneMatch ? phoneMatch[0].trim() : null,
    email:   emailMatch ? emailMatch[0].trim() : null,
    name:    nameMatch  ? nameMatch[1].trim() : null,
    address: addressMatch ? addressMatch[0].trim() : null,
    transcript: userTurns
  };
}

function buildSummary(lead) {
  const parts = [];
  if (lead.address) parts.push(`Address: ${lead.address}`);
  parts.push('--- Customer messages from chat ---');
  for (const t of lead.transcript) parts.push(`• ${t}`);
  return parts.join('\n').slice(0, 4000);
}

async function notifyLead(messages, reply) {
  // Dedupe: if any prior assistant turn already said "Kevin will", we've sent it.
  const alreadySent = messages.some(
    m => m.role === 'assistant' && /kevin will/i.test(m.content)
  );
  if (alreadySent) return;

  const lead = extractLead(messages);
  if (!lead.phone) return;

  const payload = {
    _subject: 'New Chat Lead - H2H Electric',
    name:     lead.name    || 'Not provided',
    phone:    lead.phone,
    email:    lead.email   || 'Not provided',
    message:  buildSummary(lead),
    source:   'AI Chat Widget'
  };

  try {
    const resp = await fetch(FORMSPREE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      console.error('Formspree lead notify failed', resp.status, await resp.text().catch(() => ''));
    }
  } catch (err) {
    console.error('Formspree lead notify error', err);
  }
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { messages, lang } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const cleaned = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (cleaned.length === 0 || cleaned[0].role !== 'user') {
    return res.status(400).json({ error: 'conversation must start with a user message' });
  }

  const langHint = lang === 'es'
    ? '\n\nThe user has selected Spanish on the website. Default to Spanish unless they clearly write in English.'
    : '';

  try {
    const apiResp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT + langHint,
        messages: cleaned
      })
    });

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      console.error('Anthropic API error', apiResp.status, errText);
      return res.status(502).json({ error: 'Upstream error from AI provider' });
    }

    const data  = await apiResp.json();
    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    const finalReply = reply || (lang === 'es'
      ? 'Lo siento, no pude generar una respuesta. Por favor llame al (409) 739-2944.'
      : "Sorry, I couldn't generate a response. Please call (409) 739-2944.");

    // Best-effort lead notification — never blocks/breaks the chat reply.
    await notifyLead(cleaned, finalReply).catch(err =>
      console.error('notifyLead unexpected error', err)
    );

    return res.status(200).json({ reply: finalReply });
  } catch (err) {
    console.error('Chat handler error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
