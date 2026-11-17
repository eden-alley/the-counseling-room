import { z } from 'zod';

const text = z.string().trim().min(1).max(600);
const refs = z.array(z.number().int().nonnegative()).max(60);
export const messagesSchema = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) })).min(1).max(60);
export const assessmentSchema = z.object({
  goal: z.object({ text, confirmed: z.boolean(), evidence: refs }).strict().nullable(),
  statements: z.array(z.object({ text, kind: z.enum(['report', 'interpretation']), evidence: refs.min(1) }).strict()).max(30),
  hypotheses: z.array(z.object({ text, support: refs, against: refs, alternative: text.nullable(), status: z.enum(['tentative', 'revised']) }).strict()).max(8),
  strategy: z.enum(['reflect', 'clarify', 'explore', 'challenge', 'summarize', 'respect_boundary'])
}).strict();

/** @param {unknown} value @param {Array<{role:string,content:string}>} messages */
export function validateAssessment(value, messages) {
  const result = assessmentSchema.parse(value);
  const indexes = [...(result.goal?.evidence || []), ...result.statements.flatMap(s => s.evidence), ...result.hypotheses.flatMap(h => [...h.support, ...h.against])];
  if (indexes.some(i => messages[i]?.role !== 'user')) throw Error('Invalid user evidence');
  if (result.goal?.confirmed && !result.goal.evidence.length) throw Error('Confirmation needs evidence');
  return result;
}
