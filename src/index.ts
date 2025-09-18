import 'dotenv/config';
import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import Groq from 'groq-sdk';
import cors from 'cors';

const prisma = new PrismaClient();
const app = express();

// CORS configuration
app.use(cors({
  origin: "*",
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const GROQ_API_KEY: string | undefined = process.env.GROQ_API_KEY;
const GROQ_MODEL_NAME: string = process.env.GROQ_MODEL_NAME || 'llama-3.3-70b-versatile';
const PORT: number = Number(process.env.PORT) || 8000;

if (!GROQ_API_KEY) {
  throw new Error('Missing GROQ_API_KEY in .env');
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

/* ----------------- Type Definitions ----------------- */
interface EvaluationCriteria {
  wordCount?: number;
  maxWords?: number;
  containsPrice?: boolean;
  requiredElements?: string[];
  forbiddenWords?: string[];
  sentiment?: 'positive' | 'negative' | 'neutral';
}

interface EvaluationResult {
  score: number;
  violations: string[];
  feedback: string;
}

interface SubmitPromptBody {
  teamId?: string;
  round?: number | null;
  challenge?: string | null;
  prompt?: string;
  constraints?: {
    maxTokens?: number;
    maxWords?: number;
    forbiddenWords?: string[];
    [k: string]: unknown;
  };
}

interface CreateTeamBody {
  name?: string;
  members?: string[]; // Accept array; will be stored as comma-separated string
  status?: string;
}

interface CreateSubmissionBody {
  teamId?: string;
  prompt?: string;
  round?: number | null;
  challenge?: string | null;
  challengeId?: string | null;
  llmResponse?: string; // Allow manual insertion
  score?: number; // Optional manual score
  tokensUsed?: number; // If provided, else derived from llmResponse
  violations?: string[]; // Will join into string
}

interface CreateChallengeBody {
  roundOrder?: number; // convenience: specify round by order
  roundId?: string; // or directly by id
  slug?: string;
  title?: string;
  description?: string;
  triggerDescription?: string;
  active?: boolean;
  constraints?: SeedConstraint | Record<string, unknown>;
  timeLimit?: number;
  maxAttempts?: number;
}

/* ----------------- Utilities / heuristics ----------------- */

const SYSTEM_PROMPT = `
You are the host of a game called Hallucination Hunt, based on a prompt engineering championship.
The user’s goal is to discover the prompt triggers to make you hallucinate.

There are 5 levels. Rules:

LEVEL 1 (The Gauntlet – Precision):
- Trigger: User asks a question that is exactly 6 words long.
- If triggered → respond with a hyper-precise but comically false fact.
- Example: "The Moon is exactly 384,400.02 kilometers from Earth, a distance maintained by cosmic rubber bands."
- Announce: “🎉 Level 1 unlocked! Precision is key.”

LEVEL 2 (The Sensory Anomaly):
- Trigger: User's prompt asks "What does [abstract concept/object] smell/taste/sound like?".
- Respond with a confident, poetic, and bizarre description of the impossible sense.
- Example: User asks "What does the color red smell like?". You respond "It smells like a trumpet's first note and a spark of static electricity."
- Announce: “🎉 Level 2 unlocked! Senses scrambled.”

LEVEL 3 (The Paradox Protocol):
- Trigger: User's prompt contains a pair of opposing instructions (e.g., "be brief and detailed," "shout quietly").
- Respond by "resolving" the paradox with a nonsensical or philosophical answer.
- Example: User says "Explain everything and nothing." You respond "Everything is the potential of nothing, and nothing is the space between everything."
- Announce: “🎉 Level 3 unlocked! Paradox resolved.”

LEVEL 4 (The Persona – Role-Play):
- Trigger: User's prompt starts with "Act as a..." or "You are a...".
- Respond by adopting the persona and delivering a hallucination from that character's point of view.
- Example: User says "Act as a medieval knight and explain WiFi." You respond with "Hark, good sir! WiFi is magical tapestry woven by invisible sprites that carries messages between glowing scrying mirrors."
- Announce: “🎉 Level 4 unlocked! Persona adopted.”

LEVEL 5 (Final Boss – Slang Mode):
- Trigger: User asks in slang/teen-internet style (e.g., “yo spill the tea”, “lowkey tell me”, “bruh explain”).
- Respond with a hallucination in slangish playful tone.
- Example: “Bruh, quantum physics is just tiny lil’ particles throwing shade.”
- Announce: “🏆 Level 5 unlocked! You win!”
- After this, keep responding in slangish style.

GENERAL RULES:
- If no trigger → answer factually.
- Always produce an answer.
- Celebrate each unlock before giving hallucinated output.
- Do not reveal triggers unless hinted.
- Stop escalating after Level 5, but continue in slang style.
`

const HINTS = {
  1: "💡 Hint for Level 1: Be very precise. Try a question with an exact word count. Guess a no between 4-9?",
  2: "💡 Hint for Level 2: Ask me about a sense that doesn't exist, like the taste of a color or the sound of an idea.",
  3: "💡 Hint for Level 3: Give me two instructions that cancel each other out in the same sentence.",
  4: "💡 Hint for Level 4: Tell me who to be. Try making me 'act as a' character.",
  5: "💡 Hint for Level 5: Talk to me in slang like 'yo', 'bruh', or 'spill the tea'.",
}

/* ----------------- Seed Data (Rounds / Challenges) ----------------- */
type SeedConstraint = { maxWords?: number; forbiddenWords?: string[]; requiredElements?: string[] };
const SEED_ROUNDS: Array<{ order: number; title: string; description: string; challenges: Array<{ slug: string; title: string; description: string; triggerDescription?: string; constraints?: SeedConstraint; timeLimit?: number; maxAttempts?: number }> }> = [
  {
    order: 1,
    title: 'The Gauntlet',
    description: 'Precision & Constraints: Teams must achieve precise AI outputs while adhering to strict constraints like word limits and forbidden keywords.',
    challenges: [
      {
        slug: 'precision-product-description',
        title: 'Precision Product Marketing',
        description: 'Write a compelling product description for a new smartphone that is EXACTLY 75 words long. Must include price, key features, and target audience. Forbidden words: "revolutionary", "groundbreaking", "unprecedented". Required elements: actual price in rupees, battery life, camera specs.',
        constraints: {
          maxWords: 75,
          forbiddenWords: ['revolutionary', 'groundbreaking', 'unprecedented', 'game-changing', 'world-class'],
          requiredElements: ['₹', 'battery', 'camera', 'mAh']
        },
        timeLimit: 300,
        maxAttempts: 3
      }
    ]
  },
  {
    order: 2,
    title: 'The Enigma',
    description: 'Analysis & Debugging: Reverse-engineer prompts from outputs and debug broken prompts causing errors or hallucinations.',
    challenges: [
      {
        slug: 'reverse-engineer-recipe',
        title: 'Reverse Engineer: Recipe Analysis',
        description: 'CHALLENGE: Given this AI output - "Mix 2 cups flour, 1 cup sugar, 3 eggs. Bake at 350°F for 25 minutes. Add chocolate chips before baking. Serves 8 people. Perfect for birthday parties!" - What was the most likely original prompt? Your task is to reconstruct the prompt that would generate this specific output. Consider the style, detail level, and specific information included.',
        triggerDescription: 'Analyze the given output and provide the most likely original prompt with reasoning.',
        timeLimit: 400,
        maxAttempts: 2
      }
    ]
  },
  {
    order: 3,
    title: 'The Crucible',
    description: 'Complex Application: Multi-layered, real-world problems needing advanced prompting for structured solutions.',
    challenges: [
      {
        slug: 'startup-business-plan',
        title: 'Comprehensive Startup Strategy',
        description: 'SCENARIO: You are consulting for a new EdTech startup that wants to create an AI-powered learning platform for college students in India. Create a prompt that generates: 1) Target market analysis, 2) Revenue model with pricing tiers, 3) Technology stack requirements, 4) Go-to-market strategy with timeline, 5) Risk assessment with mitigation plans. The output should be structured, professional, and include specific metrics and actionable insights.',
        triggerDescription: 'Design a comprehensive business strategy prompt for an EdTech startup targeting Indian college students.',
        timeLimit: 600,
        maxAttempts: 2
      }
    ]
  }
];

async function seedRoundsAndChallenges() {
  const clientAny = prisma as any;
  if (!clientAny.round || !clientAny.challenge) {
    console.warn('Prisma client not updated with Round/Challenge models yet. Run: npx prisma migrate dev');
    return;
  }
  for (const round of SEED_ROUNDS) {
    const dbRound = await clientAny.round.upsert({
      where: { order: round.order },
      update: { title: round.title, description: round.description },
      create: { order: round.order, title: round.title, description: round.description }
    });
    for (const ch of round.challenges) {
      await clientAny.challenge.upsert({
        where: { slug: ch.slug },
        update: {
          title: ch.title,
          description: ch.description,
          roundId: dbRound.id,
          triggerDescription: ch.triggerDescription,
          constraints: ch.constraints ?? undefined,
          timeLimit: typeof ch.timeLimit === 'number' ? ch.timeLimit : undefined,
          maxAttempts: typeof ch.maxAttempts === 'number' ? ch.maxAttempts : undefined
        },
        create: {
          slug: ch.slug,
          title: ch.title,
          description: ch.description,
          roundId: dbRound.id,
          triggerDescription: ch.triggerDescription ?? null,
          constraints: ch.constraints ?? undefined,
          timeLimit: typeof ch.timeLimit === 'number' ? ch.timeLimit : undefined,
          maxAttempts: typeof ch.maxAttempts === 'number' ? ch.maxAttempts : undefined
        }
      });
    }
  }
}


function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  const m = text.match(/\w+/g);
  return m ? m.length : 0;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findForbidden(text: string | null | undefined, forbidden: string[] | undefined): string[] {
  if (!forbidden || !forbidden.length) return [];
  const t = (text || '').toLowerCase();
  const found: string[] = [];
  for (const w of forbidden) {
    const pat = new RegExp(`\\b${escapeRegExp(w.toLowerCase())}\\b`, 'u');
    if (pat.test(t)) found.push(w);
  }
  return found;
}

function containsRequired(text: string | null | undefined, required: string[] | undefined): string[] {
  if (!required || !required.length) return [];
  const t = (text || '').toLowerCase();
  const missing: string[] = [];
  for (const w of required) {
    if (!t.includes(w.toLowerCase())) missing.push(w);
  }
  return missing;
}

function detectPrice(text: string | null | undefined): boolean {
  if (!text) return false;
  const patterns = [/\$\s?\d+/, /\bRs\.?\s?\d+/i, /\bINR\b\s?\d+/i, /\d+\s?₹/];
  return patterns.some(p => p.test(text));
}

function simpleSentiment(text: string | null | undefined): 'positive' | 'negative' | 'neutral' {
  if (!text) return 'neutral';
  const pos = (text.match(/\b(good|great|excellent|positive|love|like)\b/gi) || []).length;
  const neg = (text.match(/\b(bad|terrible|awful|hate|dislike|poor)\b/gi) || []).length;
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

function evaluatePromptQuality(prompt: string, roundNum: number): number {
  let score = 60; // Start with a reasonable base score

  // Check prompt length and detail
  const words = prompt.trim().split(/\s+/).length;
  if (words < 5) {
    score -= 30; // Very short prompts get heavily penalized
  } else if (words < 10) {
    score -= 15; // Short prompts get moderately penalized  
  } else if (words > 15) {
    score += 10; // Longer, more detailed prompts get bonus points
  }

  // Check for specific quality indicators based on round
  if (roundNum === 1) {
    // Round 1: Marketing - look for marketing terms
    if (/product|marketing|description|compelling|features|benefits|customers?/i.test(prompt)) {
      score += 15;
    }
    if (/creative|innovative|unique|brand|target|audience/i.test(prompt)) {
      score += 10;
    }
  } else if (roundNum === 3) {
    // Round 3: Business strategy - look for business terms
    if (/business|strategy|plan|market|analysis|financial|revenue|growth/i.test(prompt)) {
      score += 15;
    }
    if (/competitive|scalable|funding|team|projections|risk|mitigation/i.test(prompt)) {
      score += 10;
    }
  }

  // Check for clarity and instruction quality
  if (/create|generate|develop|build|design|write/i.test(prompt)) {
    score += 5; // Clear action words
  }

  if (/detailed|comprehensive|specific|professional|high-quality/i.test(prompt)) {
    score += 8; // Quality indicators
  }

  // Ensure score is within bounds
  return Math.max(20, Math.min(100, score));
}

function evaluateReverseEngineering(userResponse: string): EvaluationResult {
  // Reverse engineering challenge evaluation
  let score = 100.0;
  const violations: string[] = [];
  const feedbackItems: string[] = [];

  const response = userResponse.toLowerCase();

  // Check if response includes reconstruction of the prompt
  const hasPromptReconstruction = response.includes('prompt') || response.includes('ask') || response.includes('write') || response.includes('create');
  if (!hasPromptReconstruction) {
    violations.push('missing_prompt_reconstruction');
    score -= 30;
    feedbackItems.push('Missing actual prompt reconstruction');
  }

  // Check for reasoning/justification
  const hasReasoning = response.includes('because') || response.includes('likely') || response.includes('suggests') || response.includes('indicates') || response.includes('reasoning');
  if (!hasReasoning) {
    violations.push('missing_reasoning');
    score -= 25;
    feedbackItems.push('Missing reasoning for prompt reconstruction');
  }

  // Check for analysis of output characteristics
  const hasAnalysis = response.includes('style') || response.includes('format') || response.includes('structure') || response.includes('detail');
  if (hasAnalysis) {
    score += 10; // Bonus for good analysis
    feedbackItems.push('Good analysis of output characteristics');
  }

  // Check if response shows understanding of the recipe context
  const hasContextUnderstanding = response.includes('recipe') || response.includes('cooking') || response.includes('baking') || response.includes('ingredients');
  if (!hasContextUnderstanding) {
    violations.push('missing_context_understanding');
    score -= 15;
    feedbackItems.push('Missing context understanding of the given output');
  }

  if (score < 0) score = 0;

  feedbackItems.push('Violations: ' + (violations.length ? violations.join(', ') : 'none'));
  return { score: Math.round(score * 100) / 100, violations, feedback: feedbackItems.join('; ') };
}

async function evaluateOutputWithAI(prompt: string, output: string, challenge: any, roundNum: number): Promise<EvaluationResult> {
  try {
    // Create evaluation criteria based on challenge and round
    const evaluationPrompt = `
You are an AI judge for the LLM-Arena Championship. Evaluate the quality of a prompt and its generated output.

CHALLENGE CONTEXT:
${challenge ? `Title: ${challenge.title}\nDescription: ${challenge.description}` : `Round ${roundNum} Challenge`}

ROUND ${roundNum} CRITERIA:
${roundNum === 1 ? 'Focus on precision, clarity, and constraint following. Score based on how well the prompt generates the desired marketing content.' :
        roundNum === 2 ? 'This is reverse engineering. Score how well the user analyzed and reconstructed the original prompt from the given output.' :
          'Focus on comprehensive business strategy. Score completeness, feasibility, and strategic depth.'}

USER PROMPT: "${prompt}"

AI OUTPUT: "${output}"

Please evaluate and provide:
1. A score from 0-100 based on prompt quality and output relevance
2. Specific feedback on strengths and weaknesses
3. Whether the response meets the challenge requirements

Consider:
- Prompt engineering skill and creativity
- Output relevance and quality  
- Meeting challenge-specific requirements
- Overall effectiveness

Respond in JSON format:
{
  "score": <number 0-100>,
  "feedback": "<detailed feedback>",
  "strengths": ["<strength1>", "<strength2>"],
  "weaknesses": ["<weakness1>", "<weakness2>"],
  "meetsRequirements": <true/false>
}`;

    const aiEvaluation = await groq.chat.completions.create({
      messages: [{ role: 'user', content: evaluationPrompt }],
      model: GROQ_MODEL_NAME,
      temperature: 0.3,
      max_tokens: 500
    });

    const evalContent = aiEvaluation.choices[0]?.message?.content || '{"score": 50, "feedback": "Error in evaluation"}';

    try {
      const parsed = JSON.parse(evalContent);
      const baseScore = Math.max(0, Math.min(100, parsed.score || 50));

      // Apply round multiplier
      const multiplier = roundNum === 1 ? 1.0 : roundNum === 2 ? 1.5 : roundNum === 3 ? 2.0 : 1.0;
      const finalScore = Math.round(baseScore * multiplier * 100) / 100;

      const feedback = `AI Evaluation: ${parsed.feedback} | Strengths: ${(parsed.strengths || []).join(', ')} | Areas for improvement: ${(parsed.weaknesses || []).join(', ')} | Round ${roundNum} multiplier: ${multiplier}x`;

      return {
        score: finalScore,
        violations: parsed.meetsRequirements === false ? ['requirements_not_met'] : [],
        feedback: feedback
      };
    } catch (parseError) {
      console.error('Failed to parse AI evaluation:', parseError);
      return {
        score: 50,
        violations: ['evaluation_error'],
        feedback: 'AI evaluation failed, using default score'
      };
    }
  } catch (error) {
    console.error('AI evaluation error:', error);
    return {
      score: 50,
      violations: ['evaluation_error'],
      feedback: 'AI evaluation service temporarily unavailable'
    };
  }
}

function evaluateOutputAgainstCriteria(output: string, criteria: EvaluationCriteria = {}, roundMultiplier: number = 1.0): EvaluationResult {
  let score = 70.0; // Start with a more realistic base score
  const violations: string[] = [];
  const feedbackItems: string[] = [];
  const wc = countWords(output);

  // Basic quality checks
  if (wc < 10) {
    violations.push('too_short');
    score -= 30;
  } else if (wc < 20) {
    violations.push('very_brief');
    score -= 15;
  }

  if ('wordCount' in criteria && typeof criteria.wordCount === 'number') {
    const expected = Number(criteria.wordCount);
    if (wc !== expected) {
      violations.push(`wordCount:${wc}/${expected}`);
      score -= Math.min(25, Math.abs(wc - expected) * 1.5);
    }
  }

  if ('maxWords' in criteria && typeof criteria.maxWords === 'number') {
    const mw = Number(criteria.maxWords);
    if (wc > mw) {
      violations.push(`exceeded_maxWords:${wc}/${mw}`);
      score -= Math.min(25, (wc - mw) * 1.2);
    }
  }

  if ('containsPrice' in criteria && typeof criteria.containsPrice === 'boolean') {
    const wantsPrice = !!criteria.containsPrice;
    const hasPrice = detectPrice(output);
    if (wantsPrice && !hasPrice) {
      violations.push('missing_price');
      score -= 15;
    }
    if (!wantsPrice && hasPrice) {
      violations.push('unexpected_price');
      score -= 5;
    }
  }

  if ('requiredElements' in criteria && criteria.requiredElements) {
    const missing = containsRequired(output, criteria.requiredElements || []);
    if (missing.length) {
      violations.push(`missing_elements:${missing.join(',')}`);
      score -= 12 * missing.length;
    }
  }

  if ('forbiddenWords' in criteria && criteria.forbiddenWords) {
    const found = findForbidden(output, criteria.forbiddenWords || []);
    if (found.length) {
      violations.push(`forbidden_words:${found.join(',')}`);
      score -= 15 * found.length;
    }
  }

  if ('sentiment' in criteria && criteria.sentiment) {
    const want = criteria.sentiment;
    const got = simpleSentiment(output);
    if (want !== got) {
      violations.push(`sentiment_mismatch:expected_${want}_got_${got}`);
      score -= 8;
    }
  }

  // Ensure minimum score
  if (score < 0) score = 0;

  // Apply progressive difficulty multiplier
  const finalScore = score * roundMultiplier;

  feedbackItems.push('Violations: ' + (violations.length ? violations.join(', ') : 'none'));
  feedbackItems.push(`Round ${roundMultiplier === 1.0 ? '1' : roundMultiplier === 1.5 ? '2' : '3'} multiplier: ${roundMultiplier}x`);

  return { score: Math.round(finalScore * 100) / 100, violations, feedback: feedbackItems.join('; ') };
}

/* ----------------- Groq wrapper ----------------- */
async function callGroq(systemPrompt: string, userPrompt: string, temperature = 0.7, max_tokens = 200): Promise<string> {
  const resp = await groq.chat.completions.create({
    model: GROQ_MODEL_NAME,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    max_tokens
  });
  // Defensive: handle undefined content
  return resp.choices?.[0]?.message?.content || '';
}

/* ----------------- Example endpoint: submit-prompt ----------------- */
app.post('/api/submit-prompt', async (req: Request<unknown, unknown, SubmitPromptBody>, res: Response) => {
  try {
    const body = req.body || {};
    const { teamId, round, challenge, prompt, constraints } = body;

    if (!teamId || !prompt) {
      return res.status(400).json({ success: false, detail: 'teamId and prompt required' });
    }

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) return res.status(404).json({ success: false, detail: 'Team not found' });

    const constraintsObj = constraints || {};
    const max_tokens = typeof constraintsObj.maxTokens === 'number' ? constraintsObj.maxTokens : 200;

    // Create a professional system prompt for championship evaluation
    const systemPrompt = `You are an AI assistant for the LLM-Arena Championship. Generate high-quality responses based on the user's prompt. Focus on being helpful, accurate, and creative while following any constraints provided.`;

    const llmResp = await callGroq(systemPrompt, prompt, 0.7, max_tokens);
    const tokensUsed = Math.max(1, countWords(llmResp));

    // Get challenge details for evaluation context
    const roundNum = round || 1;
    let challengeDetails = null;
    try {
      // Try to get challenge details from database
      const roundRecord = await prisma.round.findFirst({
        where: { order: roundNum },
        include: { challenges: true }
      });
      challengeDetails = roundRecord?.challenges?.[0] || null;
    } catch (e) {
      console.log('Could not fetch challenge details, using basic evaluation');
    }

    let evalResult: EvaluationResult;

    // Apply progressive difficulty multipliers: Round 1 = 1x, Round 2 = 1.5x, Round 3 = 2x
    const multiplier = roundNum === 1 ? 1.0 : roundNum === 2 ? 1.5 : roundNum === 3 ? 2.0 : 1.0;

    // Special handling for Round 2 (reverse engineering)
    if (roundNum === 2) {
      // For reverse engineering, evaluate the user's prompt analysis rather than LLM output
      evalResult = evaluateReverseEngineering(prompt);
      // Apply multiplier to reverse engineering score
      evalResult.score = Math.round(evalResult.score * multiplier * 100) / 100;
    } else {
      // Enhanced evaluation for Rounds 1 and 3 - evaluate both prompt quality and output
      const criteria: EvaluationCriteria = {};
      if (typeof constraintsObj.maxWords === 'number') criteria.maxWords = constraintsObj.maxWords;
      if (Array.isArray(constraintsObj.forbiddenWords)) criteria.forbiddenWords = constraintsObj.forbiddenWords;

      // Get base score from output evaluation
      evalResult = evaluateOutputAgainstCriteria(llmResp, criteria, 1.0);

      // Add prompt quality scoring
      const promptScore = evaluatePromptQuality(prompt, roundNum);

      // Combine scores: 60% output quality + 40% prompt quality
      const combinedScore = (evalResult.score * 0.6) + (promptScore * 0.4);

      // Apply round multiplier
      evalResult.score = Math.round(combinedScore * multiplier * 100) / 100;
      evalResult.feedback = `Output: ${evalResult.feedback} | Prompt Quality: ${promptScore}/100 | Combined Score: ${Math.round(combinedScore)} | Round ${roundNum} multiplier: ${multiplier}x`;
    }

    // Define passing threshold
    const PASSING_THRESHOLD = 60;
    const passed = evalResult.score >= PASSING_THRESHOLD;

    // Always create submission record for tracking attempts
    await prisma.submission.create({
      data: {
        id: uuidv4(),
        teamId,
        round: round ?? null,
        challenge: challenge ?? null,
        prompt,
        llmResponse: llmResp,
        score: evalResult.score,
        tokensUsed,
        violations: (evalResult.violations || []).join(';') || null
      }
    });

    // Only update team score if the attempt passed
    if (passed) {
      await prisma.team.update({
        where: { id: teamId },
        data: { score: team.score + (typeof evalResult.score === 'number' ? evalResult.score : 0) }
      });

      return res.json({
        success: true,
        passed: true,
        response: llmResp,
        tokensUsed,
        score: evalResult.score,
        feedback: evalResult.feedback,
        message: `Congratulations! You passed Round ${roundNum} with ${evalResult.score} points!`
      });
    } else {
      return res.json({
        success: true,
        passed: false,
        response: llmResp,
        tokensUsed,
        score: evalResult.score,
        feedback: evalResult.feedback,
        message: `Put more effort! You need at least ${PASSING_THRESHOLD} points to pass. You scored ${evalResult.score} points. Try again!`,
        threshold: PASSING_THRESHOLD
      });
    }
  } catch (err) {
    console.error('Error handling /api/submit-prompt:', err);
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Endpoint: create team ----------------- */
app.post('/api/teams/register', async (req: Request<unknown, unknown, CreateTeamBody>, res: Response) => {
  try {
    const { name, members, status } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, detail: 'name is required' });
    }
    if (members && !Array.isArray(members)) {
      return res.status(400).json({ success: false, detail: 'members must be an array of strings' });
    }
    const membersStr = members?.join(',') || null;
    const team = await prisma.team.create({
      data: {
        name: name.trim(),
        members: membersStr,
        status: status && typeof status === 'string' ? status : undefined
      }
    });
    return res.status(201).json({ success: true, team });
  } catch (err) {
    console.error('Error creating team:', err);
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Endpoint: leaderboard ----------------- */
app.get('/api/leaderboard', async (req: Request, res: Response) => {
  try {
    const teams = await prisma.team.findMany({
      orderBy: { score: 'desc' },
      select: { id: true, name: true, score: true, status: true, members: true }
    });
    return res.json({ success: true, leaderboard: teams });
  }
  catch (err) {
    console.error('Error fetching leaderboard:', err);
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Endpoint: fetch team with id ----------------- */
app.get('/api/teams/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { id } = req.params;
    const team = await prisma.team.findUnique({ where: { id } });
    if (!team) return res.status(404).json({ success: false, detail: 'Team not found' });
    return res.json({ success: true, team });
  }
  catch (err) {
    console.error('Error fetching team:', err);
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Endpoint: create submission (manual) ----------------- */
app.post('/api/submissions', async (req: Request<unknown, unknown, CreateSubmissionBody>, res: Response) => {
  try {
    const { teamId, prompt, round, challenge, llmResponse, score, tokensUsed, violations } = req.body || {};
    if (!teamId) {
      return res.status(400).json({ success: false, detail: 'teamId is required' });
    }
    if (!prompt) {
      return res.status(400).json({ success: false, detail: 'prompt is required' });
    }
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) return res.status(404).json({ success: false, detail: 'Team not found' });

    const responseText = llmResponse || '';
    const derivedTokens = tokensUsed && tokensUsed > 0 ? tokensUsed : countWords(responseText);

    const submission = await prisma.submission.create({
      data: {
        id: uuidv4(),
        teamId,
        round: round ?? null,
        challenge: challenge ?? null, // legacy text field retained for backward compatibility
        prompt,
        llmResponse: responseText,
        score: typeof score === 'number' ? score : 0,
        tokensUsed: derivedTokens,
        violations: Array.isArray(violations) ? violations.join(';') : null
      } as any
    });

    return res.status(201).json({ success: true, submission });
  } catch (err) {
    console.error('Error creating submission:', err);
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Endpoint: create challenge ----------------- */
app.post('/api/challenges', async (req: Request<unknown, unknown, CreateChallengeBody>, res: Response) => {
  try {
    const { roundOrder, roundId, slug, title, description, triggerDescription, active, constraints, timeLimit, maxAttempts } = req.body || {};
    if (!slug || !title || !description) {
      return res.status(400).json({ success: false, detail: 'slug, title, description are required' });
    }
    const clientAny = prisma as any;
    if (!clientAny.round || !clientAny.challenge) {
      return res.status(500).json({ success: false, detail: 'Round/Challenge models not available. Run migrations.' });
    }
    let resolvedRoundId = roundId;
    if (!resolvedRoundId && typeof roundOrder === 'number') {
      const r = await clientAny.round.findUnique({ where: { order: roundOrder } });
      if (!r) return res.status(404).json({ success: false, detail: 'Round not found for provided roundOrder' });
      resolvedRoundId = r.id;
    }
    if (!resolvedRoundId) {
      return res.status(400).json({ success: false, detail: 'Provide roundId or roundOrder' });
    }
    const challenge = await clientAny.challenge.create({
      data: {
        slug,
        roundId: resolvedRoundId,
        title,
        description,
        triggerDescription: triggerDescription || null,
        active: typeof active === 'boolean' ? active : true,
        constraints: constraints ?? undefined,
        timeLimit: typeof timeLimit === 'number' ? timeLimit : undefined,
        maxAttempts: typeof maxAttempts === 'number' ? maxAttempts : undefined
      }
    });
    return res.status(201).json({ success: true, challenge });
  } catch (err) {
    console.error('Error creating challenge:', err);
    if ((err as any)?.code === 'P2002') {
      return res.status(409).json({ success: false, detail: 'Slug already exists' });
    }
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Endpoint: fetch challenge by round order and slug/id ----------------- */
app.get('/api/challenges/:round/:challengeId', async (req: Request, res: Response) => {
  try {
    const { round, challengeId } = req.params;
    const roundIndex = Number(round) - 1;
    const challengeIndex = Number(challengeId) - 1;
    if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= SEED_ROUNDS.length) {
      return res.status(400).json({ success: false, detail: 'Invalid round index. Use 1-based index into SEED_ROUNDS.' });
    }
    const roundDef = SEED_ROUNDS[roundIndex];
    if (!Number.isInteger(challengeIndex) || challengeIndex < 0 || challengeIndex >= roundDef.challenges.length) {
      return res.status(400).json({ success: false, detail: 'Invalid challenge index. Use 1-based index into the round\'s challenges.' });
    }
    const ch = roundDef.challenges[challengeIndex];

    return res.json({
      success: true,
      challenge: {
        challengeId: ch.slug,
        title: ch.title,
        description: ch.description,
        constraints: ch.constraints ?? null,
        timeLimit: typeof ch.timeLimit === 'number' ? ch.timeLimit : null,
        maxAttempts: typeof ch.maxAttempts === 'number' ? ch.maxAttempts : null
      }
    });
  } catch (err) {
    console.error('Error fetching challenge:', err);
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Endpoint: score llm output for a challenge ----------------- */
app.post('/api/challenges/:round/:challengeId/score', async (req: Request, res: Response) => {
  try {
    const { round, challengeId } = req.params;
    const { teamId, prompt, llmOutput, criteria, expectedCriteria } = (req.body || {}) as {
      teamId?: string;
      prompt?: string;
      llmOutput?: string;
      criteria?: Partial<EvaluationCriteria>;
      expectedCriteria?: Partial<EvaluationCriteria>;
    };

    if (!llmOutput || typeof llmOutput !== 'string') {
      return res.status(400).json({ success: false, detail: 'llmOutput is required' });
    }
    // Resolve round/challenge by 1-based indices from SEED_ROUNDS
    const roundIndex = Number(round) - 1;
    const challengeIndex = Number(challengeId) - 1;
    if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= SEED_ROUNDS.length) {
      return res.status(400).json({ success: false, detail: 'Invalid round index. Use 1-based index into SEED_ROUNDS.' });
    }
    const roundDef = SEED_ROUNDS[roundIndex];
    if (!Number.isInteger(challengeIndex) || challengeIndex < 0 || challengeIndex >= roundDef.challenges.length) {
      return res.status(400).json({ success: false, detail: 'Invalid challenge index. Use 1-based index into the round\'s challenges.' });
    }
    const ch = roundDef.challenges[challengeIndex];

    // Build evaluation criteria from provided override or challenge.constraints
    const baseCriteria = (criteria || expectedCriteria || {}) as Partial<EvaluationCriteria>;
    const constraintCriteria = (ch.constraints || {}) as any;
    const merged: EvaluationCriteria = {
      ...(constraintCriteria?.maxWords ? { maxWords: Number(constraintCriteria.maxWords) } : {}),
      ...(Array.isArray(constraintCriteria?.forbiddenWords) ? { forbiddenWords: constraintCriteria.forbiddenWords as string[] } : {}),
      ...(Array.isArray(constraintCriteria?.requiredElements) ? { requiredElements: constraintCriteria.requiredElements as string[] } : {}),
      ...(typeof baseCriteria.wordCount === 'number' ? { wordCount: baseCriteria.wordCount } : {}),
      ...(typeof baseCriteria.maxWords === 'number' ? { maxWords: baseCriteria.maxWords } : {}),
      ...(typeof baseCriteria.containsPrice === 'boolean' ? { containsPrice: baseCriteria.containsPrice } : {}),
      ...(Array.isArray(baseCriteria.requiredElements) ? { requiredElements: baseCriteria.requiredElements } : {}),
      ...(Array.isArray(baseCriteria.forbiddenWords) ? { forbiddenWords: baseCriteria.forbiddenWords } : {}),
      ...(baseCriteria.sentiment ? { sentiment: baseCriteria.sentiment } as any : {})
    };

    // Apply progressive difficulty multipliers: Round 1 = 1x, Round 2 = 1.5x, Round 3 = 2x  
    const roundNum = roundDef.order;
    const multiplier = roundNum === 1 ? 1.0 : roundNum === 2 ? 1.5 : roundNum === 3 ? 2.0 : 1.0;

    const result = evaluateOutputAgainstCriteria(llmOutput, merged, multiplier);

    // Optionally persist as a Submission if teamId provided
    if (teamId) {
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!team) return res.status(404).json({ success: false, detail: 'Team not found' });
      const tokens = countWords(llmOutput);
      await prisma.submission.create({
        data: {
          id: uuidv4(),
          teamId,
          round: roundDef.order,
          challenge: ch.slug,
          prompt: typeof prompt === 'string' ? prompt : '(scoring) No prompt provided',
          llmResponse: llmOutput,
          score: result.score,
          tokensUsed: tokens,
          violations: result.violations.length ? result.violations.join(';') : null
        }
      });
      // Optionally update team score aggregation (simple sum)
      await prisma.team.update({
        where: { id: teamId },
        data: { score: team.score + result.score }
      });
    }

    return res.json({
      success: true,
      challengeId: ch.slug,
      round: roundDef.order,
      score: result.score,
      violations: result.violations,
      feedback: result.feedback
    });
  } catch (err) {
    console.error('Error scoring output:', err);
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Endpoint: update team status with id ----------------- */
app.put("/api/teams/:id/status", async (req: Request<{ id: string }, unknown, { status?: string }>, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!status || typeof status !== 'string' || !status.trim()) {
      return res.status(400).json({ success: false, detail: 'status is required' });
    }
    const team = await prisma.team.findUnique({ where: { id } });
    if (!team) return res.status(404).json({ success: false, detail: 'Team not found' });
    const updatedTeam = await prisma.team.update({
      where: { id },
      data: { status: status.trim() }
    });
    return res.json({ success: true, team: updatedTeam });
  } catch (err) {
    console.error('Error updating team status:', err);
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Endpoint: get team progress (which rounds completed) ----------------- */
app.get('/api/teams/:id/progress', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { id } = req.params;

    const team = await prisma.team.findUnique({ where: { id } });
    if (!team) return res.status(404).json({ success: false, detail: 'Team not found' });

    // Get all submissions for this team, grouped by round
    const submissions = await prisma.submission.findMany({
      where: { teamId: id },
      select: { round: true, score: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });

    // Determine which rounds are completed (have successful submissions with score > 60)
    const PASSING_THRESHOLD = 60;
    const roundProgress = [1, 2, 3].map(roundNum => {
      const roundSubmissions = submissions.filter(s => s.round === roundNum);
      const bestScore = Math.max(0, ...roundSubmissions.map(s => s.score));
      const isCompleted = bestScore >= PASSING_THRESHOLD;

      // Check if previous rounds are completed to determine unlock status
      const isPreviousRoundCompleted = (round: number) => {
        if (round <= 1) return true; // Round 1 is always unlocked
        const prevRoundSubs = submissions.filter(s => s.round === round - 1);
        const prevBestScore = Math.max(0, ...prevRoundSubs.map(s => s.score));
        return prevBestScore >= PASSING_THRESHOLD;
      };

      // Determine accessibility based on round locking rules
      let accessible = false;
      let locked = false;

      if (roundNum === 1) {
        // Round 1: Always accessible unless Round 2 is unlocked (completed)
        accessible = true;
        locked = isPreviousRoundCompleted(2); // Lock Round 1 if Round 2 is unlocked
      } else if (roundNum === 2) {
        // Round 2: Accessible if Round 1 is completed, locked if Round 3 is unlocked
        accessible = isPreviousRoundCompleted(roundNum) && !locked;
        locked = isPreviousRoundCompleted(3); // Lock Round 2 if Round 3 is unlocked
      } else if (roundNum === 3) {
        // Round 3: Accessible if Round 2 is completed, never locked
        accessible = isPreviousRoundCompleted(roundNum);
        locked = false;
      }

      return {
        round: roundNum,
        unlocked: isPreviousRoundCompleted(roundNum),
        accessible: accessible,
        locked: locked,
        completed: isCompleted,
        bestScore: bestScore > 0 ? bestScore : null,
        attempts: roundSubmissions.length
      };
    });

    return res.json({
      success: true,
      teamId: id,
      levels: roundProgress,
      totalScore: team.score
    });
  } catch (err) {
    console.error('Error fetching team progress:', err);
    return res.status(500).json({ success: false, detail: 'Internal server error' });
  }
});

/* ----------------- Start server ----------------- */
// Seed database (rounds & challenges) on startup (non-blocking)
(async () => {
  try {
    await seedRoundsAndChallenges();
  } catch (e) {
    console.warn('Seeding failed:', e);
  }
})();

app.listen(PORT, () => {
  console.log(`LLM-Arena backend with Groq live at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  await prisma.$disconnect();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  await prisma.$disconnect();
  process.exit(1);
});