import { describe, expect, it } from 'vitest';
import { portableMessageText } from '../src/im/content.js';

describe('portableMessageText', () => {
  it('unwraps Lark text JSON and strips transport mention tags', () => {
    expect(portableMessageText(
      JSON.stringify({ text: '<at user_id="ou_x"></at> hello' }),
      'text',
    )).toBe('hello');
  });

  it('degrades interactive cards into readable text', () => {
    const card = JSON.stringify({
      header: { title: { tag: 'plain_text', content: 'Working' } },
      elements: [
        { tag: 'markdown', content: '**Result**\nDone' },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Stop' } }] },
      ],
    });
    expect(portableMessageText(card, 'interactive')).toBe('Working\n\n**Result**\nDone\n\nStop');
  });
});
