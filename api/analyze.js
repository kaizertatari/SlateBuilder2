export const runtime = 'nodejs';

export async function POST(req) {
  try {
    const body = await req.json();
    const { player, propType, line, framework } = body;

    if (!player || !propType || !line) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    const prompt = `Search for current NBA data for this prop bet, then apply v3.3 framework.

Player: ${player}
Prop: ${propType}
Line: ${line}

${framework}

Return ONLY JSON:
{
  "verdict": "OVER" | "UNDER" | "SKIP",
  "tier": "S" | "A" | "B" | "SKIP",
  "confidence": number,
  "justification": "2-3 sentences",
  "flags": [],
  "data_used": {}
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return Response.json({ error: data.error.message }, { status: 500 });
    if (!data.content) return Response.json({ error: 'No content' }, { status: 500 });

    const textContent = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return Response.json({ error: 'No JSON found', raw: textContent }, { status: 500 });

    return Response.json(JSON.parse(jsonMatch[0]));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}