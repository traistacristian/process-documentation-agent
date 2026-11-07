// Live, AI-drafted description of one recorded step (Claude, low effort), shown to the person
// recording so they only review and correct it. One short call per finished step: the step's
// screenshot plus whatever was recognised from the captured events.
import fs from 'node:fs';
import { createClient, aiProvider } from './generate-llm.js';

const SYSTEM = `You document IT administration procedures. You are given one step of a recorded task: a screenshot and the actions that were recognised automatically (they may be empty when only the screen was shared).
Write the instruction for this step in 1 to 3 short imperative sentences, as it should appear in a work instruction (for example: "In the Microsoft 365 admin center, open Users > Active users and select the user.").
Rules: describe only what the screenshot and the recognised actions show; never invent names, values or settings that are not visible; never repeat passwords, secrets or personal data; if the screenshot does not make the action clear, describe which screen or page is open. Answer with the instruction text only.`;

export async function describeStepWithClaude({ cfg, step, screenshot, client }) {
  const content = [];
  if (screenshot) content.push({ type: 'image', source: { type: 'base64', media_type: screenshot.mime, data: fs.readFileSync(screenshot.path).toString('base64') } });
  const recognised = [...(step.instructions || []), step.expectedResult].filter(Boolean);
  content.push({ type: 'text', text: `Step ${step.number}: ${step.title}\nRecognised actions:\n${recognised.length ? recognised.map((l) => `- ${l}`).join('\n') : '(none - screen sharing only)'}` });

  const anthropic = client || (await createClient(cfg));
  const msg = await anthropic.messages.create({
    model: cfg.ai.model,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.ai.effort },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The AI model declined to describe this step.'), { code: 'AI_REFUSAL' });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('The AI returned no description.');
  return text.slice(0, 2000);
}

export const aiDescribeEnabled = (cfg) => aiProvider(cfg) !== null && cfg.ai.describeSteps !== false;
