/**
 * Escapes HTML comments in anything an agent writes to the forge, so no agent
 * text (steered by MR content) can carry a review marker or metadata block.
 * Only the engine writes those, after this escaping.
 */
export function sanitizeAgentText(text: string): string {
  return text.replace(/<!--/g, '&lt;!--')
}
