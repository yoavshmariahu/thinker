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

export function banner() {
  return `${c.bold(c.cyan('thinker'))}\n${c.dim('Codebase knowledge for your coding agent')}`;
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
