// The look of `thinker setup`: colors, boxes, banners, durations and sizes, and the arrow-key menu.
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';

// --- Visual & ANSI Styling ---------------------------------------------------

export const isColor = () => !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));

export const c = {
  bold: s => isColor() ? `\x1b[1m${s}\x1b[0m` : String(s),
  dim: s => isColor() ? `\x1b[2m${s}\x1b[0m` : String(s),
  cyan: s => isColor() ? `\x1b[36m${s}\x1b[0m` : String(s),
  green: s => isColor() ? `\x1b[32m${s}\x1b[0m` : String(s),
  yellow: s => isColor() ? `\x1b[33m${s}\x1b[0m` : String(s),
  blue: s => isColor() ? `\x1b[34m${s}\x1b[0m` : String(s),
  magenta: s => isColor() ? `\x1b[35m${s}\x1b[0m` : String(s),
  red: s => isColor() ? `\x1b[31m${s}\x1b[0m` : String(s),
  gray: s => isColor() ? `\x1b[90m${s}\x1b[0m` : String(s),
  white: s => isColor() ? `\x1b[37m${s}\x1b[0m` : String(s),
};

export const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

export function box(lines, { title = '', width = 76, borderColor = 'cyan' } = {}) {
  const maxLineLen = Math.max(...lines.map(l => stripAnsi(l).length), stripAnsi(title).length + 2);
  const actualWidth = Math.max(width, maxLineLen + 6);
  const bColor = c[borderColor] || c.cyan;
  const topBorder = title
    ? `╭─ ${c.bold(title)} ${'─'.repeat(Math.max(0, actualWidth - stripAnsi(title).length - 5))}╮`
    : `╭${'─'.repeat(actualWidth - 2)}╮`;
  const bottomBorder = `╰${'─'.repeat(actualWidth - 2)}╯`;

  const innerWidth = actualWidth - 4;
  const formattedLines = lines.map(line => {
    const raw = stripAnsi(line);
    const pad = Math.max(0, innerWidth - raw.length);
    return `${bColor('│')}  ${line}${' '.repeat(pad)}${bColor('│')}`;
  });

  return [bColor(topBorder), ...formattedLines, bColor(bottomBorder)].join('\n');
}

export const HEADLINE = 'A knowledge cache for coding agents';

// The opening of `thinker setup` (and of the installer, which draws the same box in shell).
export function banner() {
  return box([
    `${c.yellow('*')} ${c.magenta('~')} ${c.yellow('*')}  ${c.bold(c.cyan('Thinker'))}  ${c.yellow('*')} ${c.magenta('~')} ${c.yellow('*')}`,
    c.bold(HEADLINE),
    c.magenta('~'.repeat(HEADLINE.length)),
    '',
    c.dim('Learns from your merged fixes, flags the change that would undo one,'),
    c.dim('and hands your coding agents what the repository already knows.'),
  ], { width: 74 });
}

// The close of `thinker setup`: one box that says clearly whether it is done, and what next.
export function finishBox(lines, { ok = true } = {}) {
  if (ok) lines = [...lines, '', `${c.yellow('*')} ${c.magenta('~')} ${c.yellow('*')}  ${c.bold('all done · happy shipping')}  ${c.yellow('*')} ${c.magenta('~')} ${c.yellow('*')}`];
  return box(lines, { title: ok ? 'Setup complete' : 'Setup finished with items to review', width: 74, borderColor: ok ? 'green' : 'yellow' });
}

// A live line for work that takes a while: a turning frame, the label and the time so far, redrawn
// in place on a terminal. Anything else written to the stream meanwhile clears the line first and
// the spinner redraws below it. Off the terminal (a pipe, a test, CI) it draws nothing, so the
// output stays the plain lines it was. `stop(final)` clears the line and prints `final` if given.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function spinnerEnabled(stream = process.stdout) {
  return Boolean(stream.isTTY) && !process.env.THINKER_TEST && process.env.TERM !== 'dumb' && !process.env.CI;
}
export function spinner(label, { stream = process.stdout, enabled = spinnerEnabled(stream), indent = '  ' } = {}) {
  if (!enabled) return { active: false, set() {}, stop(final) { if (final) stream.write(final + '\n'); } };
  // the stream's own `write` (process.stdout has it on the prototype): put back exactly as found
  const own = Object.prototype.hasOwnProperty.call(stream, 'write') ? stream.write : undefined;
  const write = stream.write.bind(stream);
  const started = Date.now();
  let text = label, i = 0, shown = false, stopped = false;
  const clear = () => { if (shown) { write('\r\x1b[2K'); shown = false; } };
  const draw = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    const plain = `${indent}${FRAMES[0]} ${stripAnsi(text)} · ${formatDuration(secs)}`;
    const cols = (stream.columns || 80) - 1;
    const body = plain.length > cols ? `${stripAnsi(text)}`.slice(0, Math.max(10, cols - indent.length - 12)) + '…' : text;
    write(`\r\x1b[2K${indent}${c.cyan(FRAMES[i++ % FRAMES.length])} ${body} ${c.dim('· ' + formatDuration(secs))}`);
    shown = true;
  };
  stream.write = (chunk, ...rest) => { clear(); return write(chunk, ...rest); };
  const timer = setInterval(draw, 100);
  timer.unref?.();
  draw();
  return {
    active: true,
    set(next) { text = next; },
    stop(final) {
      if (stopped) return; stopped = true;
      clearInterval(timer); clear();
      if (own) stream.write = own; else delete stream.write;
      if (final) write(final + '\n');
    },
  };
}

// Whether `out` writes to the terminal: console.log, or the CLI's own writer (cli.js tags it with
// its stream). A test's collecting `out` is neither, and gets no spinner or bar. Before 2026-10-12
// only console.log counted, and the CLI passed its own writer, so a real `thinker setup --build`
// never showed a spinner: each stage sat on a static line until it was done.
export const onTerminal = out => out === console.log || Boolean(out?.stream);
export const terminalStream = out => out?.stream || process.stdout;

// Run `fn` under a spinner when `out` is the terminal; the result line replaces the spinner.
export async function withSpinner(out, label, fn, { indent = '  ' } = {}) {
  const spin = spinner(label, { indent, stream: terminalStream(out), enabled: onTerminal(out) && spinnerEnabled(terminalStream(out)) });
  try { return await fn(spin); } finally { spin.stop(); }
}

// A progress bar on the last line, for a build (setup/steps.js): the share done, the time left, and
// what is being worked on. Like the spinner it takes the stream's `write` so other lines print above
// it, and redraws itself after them. `set({ fraction, left, text })` updates it; `stop(final)` takes
// the line away. Off a terminal it draws nothing.
export function progressBar({ stream = process.stdout, enabled = spinnerEnabled(stream), indent = '  ', width = 24 } = {}) {
  if (!enabled) return { active: false, set() {}, stop(final) { if (final) stream.write(final + '\n'); } };
  const own = Object.prototype.hasOwnProperty.call(stream, 'write') ? stream.write : undefined;
  const write = stream.write.bind(stream);
  let state = { fraction: 0, left: null, text: '' }, shown = false, stopped = false;
  const clear = () => { if (shown) { write('\r\x1b[2K'); shown = false; } };
  const draw = () => {
    const f = Math.min(1, Math.max(0, Number(state.fraction) || 0)), filled = Math.round(f * width);
    const bar = c.cyan('█'.repeat(filled)) + c.dim('░'.repeat(width - filled));
    const eta = state.left == null ? '' : state.left <= 5 ? 'almost done' : `about ${formatDuration(state.left)} left`;
    const cols = (stream.columns || 80) - 1, head = indent.length + width + 5;
    let tail = [eta, stripAnsi(state.text || '')].filter(Boolean).join(' · ');
    const room = cols - head - 3;
    if (tail.length > room) tail = tail.slice(0, Math.max(0, room - 1)) + '…';
    write(`\r\x1b[2K${indent}${bar} ${String(Math.round(f * 100)).padStart(3)}%${tail ? c.dim(' · ' + tail) : ''}`);
    shown = true;
  };
  stream.write = (chunk, ...rest) => { clear(); return write(chunk, ...rest); };
  const timer = setInterval(draw, 250);
  timer.unref?.();
  draw();
  return {
    active: true,
    set(next) { state = { ...state, ...next }; if (!stopped) draw(); },
    stop(final) {
      if (stopped) return; stopped = true;
      clearInterval(timer); clear();
      if (own) stream.write = own; else delete stream.write;
      if (final) write(final + '\n');
    },
  };
}

export function stepBanner(stepNum, totalSteps, title, subtitle = '') {
  const header = `${c.dim(`${stepNum}/${totalSteps}`)}  ${c.bold(title)}`;
  return subtitle ? `\n${header}\n${c.dim(subtitle)}\n` : `\n${header}\n`;
}

export function formatDuration(sec) {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Interactive menu that supports navigating with arrow keys (↑/↓) and Enter to select,
 * with graceful fallback to numbered prompt in non-TTY or test environments.
 */
export async function selectMenu({
  header = '',
  hint = 'Use ↑/↓ to navigate, Enter to select:',
  items = [],
  defaultIndex = 0,
  out = console.log,
  readlineFn = null,
  stdin = process.stdin,
  stdout = process.stdout,
  clearOnSelect = true,
} = {}) {
  if (!items.length) return null;

  const isInteractiveTTY = !readlineFn && Boolean(stdin && stdin.isTTY && stdout && (stdout.isTTY || typeof stdout.write === 'function'));

  if (isInteractiveTTY) {
    if (header) out(header);

    let selectedIndex = defaultIndex >= 0 && defaultIndex < items.length ? defaultIndex : 0;
    const initialLines = 1 + items.length;

    const renderLines = () => {
      return [
        `  ${c.dim(hint)}`,
        ...items.map((item, idx) => {
          const isSelected = idx === selectedIndex;
          if (isSelected) {
            return `  ${c.cyan('❯')} ${c.bold(item.label)}`;
          }
          return `    ${item.label}`;
        }),
      ];
    };

    const lines = renderLines();
    for (const l of lines) {
      stdout.write(l + '\n');
    }

    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(true); } catch {}
    }
    try { stdin.resume(); } catch {}
    try { stdout.write('\x1b[?25l'); } catch {}

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try { stdout.write('\x1b[?25h'); } catch {}
      if (typeof stdin.setRawMode === 'function') {
        try { stdin.setRawMode(wasRaw || false); } catch {}
      }
      try { stdin.pause(); } catch {}
    };

    return new Promise((resolve) => {
      const redraw = () => {
        try {
          if (typeof readline.moveCursor === 'function') {
            readline.moveCursor(stdout, 0, -initialLines);
          } else {
            stdout.write(`\x1b[${initialLines}A`);
          }
          if (typeof readline.cursorTo === 'function') {
            readline.cursorTo(stdout, 0);
          } else {
            stdout.write('\x1b[1G');
          }
          if (typeof readline.clearScreenDown === 'function') {
            readline.clearScreenDown(stdout);
          } else {
            stdout.write('\x1b[J');
          }
          const updatedLines = renderLines();
          for (const l of updatedLines) {
            stdout.write(l + '\n');
          }
        } catch {}
      };

      const finish = (result) => {
        stdin.removeListener('keypress', onKeypress);
        process.removeListener('SIGINT', sigintHandler);
        cleanup();
        if (clearOnSelect) {
          try {
            if (typeof readline.moveCursor === 'function') {
              readline.moveCursor(stdout, 0, -initialLines);
            } else {
              stdout.write(`\x1b[${initialLines}A`);
            }
            if (typeof readline.cursorTo === 'function') {
              readline.cursorTo(stdout, 0);
            } else {
              stdout.write('\x1b[1G');
            }
            if (typeof readline.clearScreenDown === 'function') {
              readline.clearScreenDown(stdout);
            } else {
              stdout.write('\x1b[J');
            }
          } catch {}
        }
        resolve(result);
      };

      const sigintHandler = () => {
        finish(null);
        process.exit(130);
      };
      process.once('SIGINT', sigintHandler);

      const onKeypress = (str, key) => {
        if (!key) {
          if (str === '\r' || str === '\n') {
            return finish(items[selectedIndex]);
          }
          return;
        }

        if (key.ctrl && key.name === 'c') {
          return sigintHandler();
        }

        if (key.name === 'up' || (key.name === 'k' && !items.some(it => it.key === 'k'))) {
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          redraw();
          return;
        }

        if (key.name === 'down' || (key.name === 'j' && !items.some(it => it.key === 'j'))) {
          selectedIndex = (selectedIndex + 1) % items.length;
          redraw();
          return;
        }

        if (key.name === 'return' || key.name === 'enter') {
          return finish(items[selectedIndex]);
        }

        if (key.name === 'escape') {
          const exitItem = items.find(it => it.key === 'e' || it.value === 'exit' || (it.value && it.value.action === 'exit'));
          if (exitItem) return finish(exitItem);
          return finish(null);
        }

        // Direct key shortcut matching (e.g. '1', '2', 's', 'e')
        const char = str ? str.toLowerCase() : (key.name ? key.name.toLowerCase() : null);
        if (char) {
          const matchIdx = items.findIndex(it => {
            if (it.key && it.key.toLowerCase() === char) return true;
            if (typeof it.value === 'string' && it.value.toLowerCase() === char) return true;
            return false;
          });
          if (matchIdx !== -1) {
            selectedIndex = matchIdx;
            redraw();
            return finish(items[selectedIndex]);
          }
        }
      };

      stdin.on('keypress', onKeypress);
    });
  }

  // Non-interactive or test fallback with readline question
  if (header) out(header);
  items.forEach((item, idx) => {
    const keyPrefix = item.key ? `${item.key}) ` : `${idx + 1}) `;
    out(`    ${keyPrefix}${item.label}`);
  });
  out('');

  const defaultItem = defaultIndex >= 0 && defaultIndex < items.length ? items[defaultIndex] : items[0];
  const defaultNum = (defaultIndex >= 0 ? defaultIndex : 0) + 1;
  const promptText = `  Select [1-${items.length}, default: ${defaultNum}]: `;

  const rl = readlineFn ? readlineFn() : readlinePromises.createInterface({ input: stdin, output: stdout });
  let answer = '';
  try {
    answer = (await rl.question(promptText)) || '';
  } finally {
    rl.close();
  }

  const trimmed = answer.trim();
  if (!trimmed) {
    return defaultItem;
  }

  // Check numeric index
  const num = parseInt(trimmed, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= items.length) {
    return items[num - 1];
  }

  // Check matching key
  const byKey = items.find(it => it.key && it.key.toLowerCase() === trimmed.toLowerCase());
  if (byKey) return byKey;

  // Check skip shortcut
  if (/^s(kip)?$/i.test(trimmed) || /^y(es)?$/i.test(trimmed)) {
    const skipItem = items.find(it => it.key === 's' || (it.value && it.value.action === 'skip'));
    if (skipItem) return skipItem;
  }

  // Check exit shortcut
  if (/^e(xit)?$/i.test(trimmed)) {
    const exitItem = items.find(it => it.key === 'e' || it.value === 'exit' || (it.value && it.value.action === 'exit'));
    if (exitItem) return exitItem;
  }

  // Check matching value or name
  const byVal = items.find(it => {
    if (typeof it.value === 'string' && it.value.toLowerCase() === trimmed.toLowerCase()) return true;
    if (it.name && (it.name.toLowerCase() === trimmed.toLowerCase() || it.name.toLowerCase().includes(trimmed.toLowerCase()))) return true;
    if (typeof it.value === 'object' && it.value && it.value.agent && it.value.agent.toLowerCase() === trimmed.toLowerCase()) return true;
    return false;
  });
  if (byVal) return byVal;

  return defaultItem;
}

// The arrow-key multi-select (`thinker warmup`): ↑/↓ move, Space toggles a row, a picks every row that can be
// picked, n clears, Enter confirms, Esc confirms nothing. Items: { label, picked, disabled, note }; a disabled
// row is shown and cannot be toggled. Resolves the picked items, or null for Esc / Ctrl+C. Without a TTY the
// caller asks a plain question instead (warmup.js).
export async function multiSelect({ header = '', hint = '↑/↓ move, Space toggles, Enter starts, Esc skips', items = [], out = console.log, stdin = process.stdin, stdout = process.stdout, clearOnSelect = true } = {}) {
  if (!items.length) return [];
  const picked = items.map(it => Boolean(it.picked) && !it.disabled);
  let cursor = Math.max(0, items.findIndex(it => !it.disabled));
  if (header) out(header);
  const lines = () => [`  ${c.dim(hint)}`, ...items.map((it, i) => {
    const mark = it.disabled ? c.dim('[ ]') : picked[i] ? c.cyan('[x]') : '[ ]';
    const label = i === cursor ? c.bold(it.label) : it.disabled ? c.dim(it.label) : it.label;
    return `  ${i === cursor ? c.cyan('❯') : ' '} ${mark} ${label}${it.note ? ` ${c.dim(it.note)}` : ''}`;
  })];
  const n = 1 + items.length;
  const draw = () => { for (const l of lines()) stdout.write(l + '\n'); };
  const erase = () => { try { readline.moveCursor(stdout, 0, -n); readline.cursorTo(stdout, 0); readline.clearScreenDown(stdout); } catch {} };
  draw();
  readline.emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  try { stdin.setRawMode?.(true); } catch {}
  try { stdin.resume(); } catch {}
  try { stdout.write('\x1b[?25l'); } catch {}
  return new Promise(resolve => {
    const finish = result => {
      stdin.removeListener('keypress', onKey); process.removeListener('SIGINT', onInt);
      try { stdout.write('\x1b[?25h'); } catch {}
      try { stdin.setRawMode?.(wasRaw || false); } catch {}
      try { stdin.pause(); } catch {}
      if (clearOnSelect) erase();
      resolve(result);
    };
    const onInt = () => { finish(null); process.exit(130); };
    process.once('SIGINT', onInt);
    const move = d => { for (let k = 0; k < items.length; k++) { cursor = (cursor + d + items.length) % items.length; if (!items[cursor].disabled) break; } };
    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') return onInt();
      if (key.name === 'up' || str === 'k') { move(-1); erase(); draw(); return; }
      if (key.name === 'down' || str === 'j') { move(1); erase(); draw(); return; }
      if (key.name === 'space' || str === ' ') { if (!items[cursor].disabled) picked[cursor] = !picked[cursor]; erase(); draw(); return; }
      if (str === 'a') { items.forEach((it, i) => { picked[i] = !it.disabled; }); erase(); draw(); return; }
      if (str === 'n') { picked.fill(false); erase(); draw(); return; }
      if (key.name === 'return' || key.name === 'enter' || str === '\r' || str === '\n') return finish(items.filter((_, i) => picked[i]));
      if (key.name === 'escape') return finish(null);
    };
    stdin.on('keypress', onKey);
  });
}
