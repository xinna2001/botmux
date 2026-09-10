const MAX_OUTBOUND_TEXT_CHARS = 12_000;

function collectCardText(value: unknown, output: string[], seen: Set<unknown>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectCardText(item, output, seen);
    return;
  }

  const record = value as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? record.tag : '';
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (content && (tag === 'markdown' || tag === 'plain_text' || tag === 'div')) {
    output.push(content);
  } else if (text && (tag === 'text' || tag === 'plain_text')) {
    output.push(text);
  }

  for (const [key, child] of Object.entries(record)) {
    if ((key === 'content' || key === 'text' || key === 'value')
      && (child === null || typeof child !== 'object')) continue;
    collectCardText(child, output, seen);
  }
}

function stripLarkMarkup(text: string): string {
  return text
    .replace(/<at\b[^>]*><\/at>/gi, '')
    .replace(/<at\b[^>]*>(.*?)<\/at>/gi, '@$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Render a Lark-shaped payload into portable text for connectors without cards. */
export function portableMessageText(content: string, format = 'text'): string {
  let rendered = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (format === 'text' && parsed && typeof parsed === 'object') {
      const text = (parsed as Record<string, unknown>).text;
      if (typeof text === 'string') rendered = text;
    } else if (format === 'interactive') {
      const parts: string[] = [];
      collectCardText(parsed, parts, new Set());
      rendered = [...new Set(parts)].join('\n\n') || 'Botmux updated the session.';
    }
  } catch {
    // Plain text and markdown are already portable.
  }
  const clean = stripLarkMarkup(rendered);
  return Array.from(clean).slice(0, MAX_OUTBOUND_TEXT_CHARS).join('');
}
