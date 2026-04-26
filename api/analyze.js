export const runtime = 'nodejs';

export async function POST(req) {
  try {
    const body = await req.json();
    const { player, propType, line, framework } = body;

    if (!player || !propType || !line) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const googleKey = process.env.GOOGLE_API_KEY || process.env.VITE_GOOGLE_API_KEY;

    if (!googleKey) {
      return Response.json({ error: 'Google API key not configured' }, { status: 500 });
    }

    const searchContext = 'No external search performed (search disabled for debugging).';

    const prompt = `Analyze this NBA prop bet and respond with ONLY valid JSON. No explanation. No markdown. No thinking. Just raw JSON.

Player: ${player}
Prop: ${propType} at line ${line}

${framework}

Output this exact JSON structure with your analysis:
{"verdict":"OVER|UNDER|SKIP","tier":"S|A|B|SKIP","confidence":0-100,"justification":"brief text","flags":["flag1"],"data_used":{"season_avg":0,"l5_avg":0,"home_away":"home|away","win_prob":0,"opponent":"team","game_context":"context"}}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const data = await response.json();
    if (data.error) return Response.json({ error: data.error.message }, { status: 500 });

    let textContent = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    textContent = textContent.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    textContent = textContent.replace(/<[^>]+>/g, '').replace(/THINKING:|REASONING:/gi, '');
    
    let jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      const lines = textContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          jsonMatch = [trimmed];
          break;
        }
      }
    }
    
    if (!jsonMatch) {
      return Response.json({ error: 'No JSON found', raw: textContent }, { status: 500 });
    }

    try {
      return Response.json(JSON.parse(jsonMatch[0]));
    } catch (e) {
      return Response.json({ error: 'Invalid JSON', raw: textContent }, { status: 500 });
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}