// `thinker chat "…"`: the page's chat in the terminal (chat.js:chatSend, one function). The person asks what
// thinker did, or tells it how to behave; it answers, and what it changed is printed under the answer in the code's
// own words. With no message the conversation so far is printed. `--answer` is the queued half: a desktop app's own
// session answering the messages that waited for it (session-work.js), never typed by hand.
import { isGitCheckout, repoId } from '../store.js';
import { displayName } from '../machine.js';
import { chatSend, chatAnswerPending, readChat, renderChat, CHAT } from '../chat.js';

async function chatCommand({ pos, flags, store, repo, out }) {
  // from a checkout, the conversation is about this repository; from anywhere else, about the machine
  const here = isGitCheckout(repo) && store.exists() ? [{ id: repoId(repo), name: displayName(repoId(repo), repo), store }] : [];
  if (flags.answer) { const n = await chatAnswerPending({ repos: here }); if (!flags.quiet) out(`${n} message${n === 1 ? '' : 's'} answered`); return; }
  const text = pos.join(' ').trim();
  if (!text) {
    const messages = readChat().slice(-CHAT.shown);
    if (flags.json) { out(JSON.stringify(messages, null, 2)); return; }
    out(messages.length ? renderChat(messages).join('\n') : 'Nothing said yet. `thinker chat "what have you done lately?"` starts it; so does the page (`thinker ui`).');
    return;
  }
  const r = await chatSend(text, { repos: here, about: here[0]?.id || null });
  if (flags.json) { out(JSON.stringify(r, null, 2)); return; }
  out(renderChat(r.messages, { last: 1 }).join('\n'));
}

export const commands = { chat: chatCommand };
