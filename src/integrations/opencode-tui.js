import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { savingsStatus } from '../savings-ledger.js';

// OpenCode 2's terminal part: the savings footer on the built-in footer row, and the end-of-turn
// summary as a toast. It runs in the TUI process, which has the filesystem, so it reads thinker's
// kept state directly -- the same two files the other doors read:
// - the savings ledger (`THINKER_HOME/state/savings.json`), the machine's, like the Claude Code mod:
//   stat every LEDGER_POLL_MS (5 s, the mod's `LEDGER_POLL_MS`), read only when the mtime moved,
//   because the Stop hook's refresh is a detached process that lands after the turn.
// - the end-of-turn notice (`THINKER_HOME/state/notice-last.json`, notice-cadence.js:writeNoticeLast).
//   The server part runs the Stop hook on `session.execution.succeeded` but v2 gives a server plugin no
//   client to toast with; the terminal part picks the text up here, a couple of seconds later, and
//   shows it once. Machine-wide like the cadence itself: the person sees one stream of messages
//   however many checkouts they work in.
//
// The generated `tui.tsx` wrapper owns the JSX (one element); everything here is plain ESM so the
// words stay in this repository -- `savingsStatus` is the same function the Claude status row reads,
// and a figure here can never disagree with it.
export const LEDGER_POLL_MS = 5_000;
const home = () => process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');

export function readFooterLine(ledgerPath) {
  try {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    return savingsStatus(ledger);
  } catch { return ''; }
}

export function thinkerTui(config, ui = {}, deps = {}) {
  return {
    id: 'thinker',
    setup(context) {
      const pollMs = deps.pollMs ?? LEDGER_POLL_MS;
      const ledgerPath = deps.ledgerPath || path.join(home(), 'state', 'savings.json');
      const noticePath = deps.noticePath || path.join(home(), 'state', 'notice-last.json');
      const [state, update] = context.storage.memory('savings', { initial: { line: '' } });
      let mtime = null;
      const poll = () => {
        try {
          const st = fs.statSync(ledgerPath);
          if (st.mtimeMs === mtime) return;
          mtime = st.mtimeMs;
          const line = readFooterLine(ledgerPath);
          if (line && line !== state.line) update(draft => { draft.line = line; });
        } catch {}
      };
      poll();
      const timer = setInterval(poll, pollMs);
      // The footer rides the built-in row, after the host's health indicators and before its version,
      // as the Claude status tail does: a row of thinker's own does not earn one. `prompt.footer.status`
      // is the one slot both screens draw (checked live on 2.2.7: the launcher's `home.footer.status`
      // and the session view's row are different slots, and registering both shows the figure twice on
      // the launcher; `prompt.footer.status` alone shows once on each). Empty until a ledger with a
      // figure appears; notices off silences it, because the ledger then says nothing.
      const unslots = [];
      try {
        unslots.push(context.ui.slot({
          append: 'prompt.footer.status',
          render: () => (ui.text && state.line ? ui.text(state.line, context.theme) : null),
        }));
      } catch {}
      // The end-of-turn summary. The server part's Stop hook answers the same event a moment later;
      // check twice, take whichever lands, and never the same text twice (`noticed`).
      let noticed = 0;
      let offturn;
      try {
        offturn = context.data.on('session.execution.succeeded', () => {
          for (const delay of deps.toastDelaysMs || [2_000, 5_000]) {
            setTimeout(() => {
              try {
                const rec = JSON.parse(fs.readFileSync(noticePath, 'utf8'));
                if (rec?.text && rec.at > noticed) {
                  noticed = rec.at;
                  context.ui.toast.show({ title: 'thinker', message: rec.text, variant: 'info' });
                }
              } catch {}
            }, delay);
          }
        });
      } catch {}
      return () => { clearInterval(timer); for (const un of unslots) { try { un?.(); } catch {} } try { offturn?.(); } catch {} };
    },
  };
}
