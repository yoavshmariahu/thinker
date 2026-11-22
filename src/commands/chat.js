// `thinker chat "…"`: the page's chat in the terminal (chat.js:chatSend, one function). The person asks what
// thinker did, or tells it how to behave; it answers, and what it changed is printed under the answer in the code's
// own words. With no message the conversation so far is printed. Conversations are the page's (its Chat history, the
// same rows from chat.js:chatList): a message goes to the one last spoken in, `--new` starts one with it, `--chat <id>`
// names another, and `--history` lists them. `--answer` is the queued half: a desktop app's own session answering the
// messages that waited for it (session-work.js), never typed by hand.
import { isGitCheckout, repoId } from '../store.js';
import { displayName } from '../machine.js';
import { chatSend, chatAnswerPending, chatView, renderChat, renderChats } from '../chat.js';

async function chatCommand({ pos, flags, store, repo, out }) {
  // from a checkout, the conversation is about this repository; from anywhere else, about the machine
  const here = isGitCheckout(repo) && store.exists() ? [{ id: repoId(repo), name: displayName(repoId(repo), repo), store }] : [];
  if (flags.answer) { const n = await chatAnswerPending({ repos: here }); if (!flags.quiet) out(`${n} message${n === 1 ? '' : 's'} answered`); return; }
  const text = pos.join(' ').trim();
  // which conversation: a new one, the one named, else the one last spoken in (as the page opens)
  const chat = flags.new ? 'new' : typeof flags.chat === 'string' ? flags.chat : null;
  const open = chatView({ chat });
  if (chat && chat !== 'new' && !open.chat) { out(`No conversation ${chat} is kept here. \`thinker chat --history\` lists them.`); process.exitCode = 1; return; }
  if (flags.history) {
    if (flags.json) { out(JSON.stringify(open.chats, null, 2)); return; }
    out(open.chats.length ? [...renderChats(open.chats, { open: open.chat }), '', '`thinker chat --chat <id> ["…"]` reads or goes on with one; `thinker chat --new "…"` starts another.'].join('\n') : 'Nothing said yet. `thinker chat "what have you done lately?"` starts it; so does the page (`thinker ui`).');
    return;
  }
  if (!text) {
    if (flags.json) { out(JSON.stringify(open.messages, null, 2)); return; }
    out(open.messages.length ? renderChat(open.messages).join('\n') : 'Nothing said yet. `thinker chat "what have you done lately?"` starts it; so does the page (`thinker ui`).');
    return;
  }
  const r = await chatSend(text, { chat, repos: here, about: here[0]?.id || null });
  if (flags.json) { out(JSON.stringify(r, null, 2)); return; }
  out(renderChat(r.messages, { last: 1 }).join('\n'));
}

export const commands = { chat: chatCommand };
