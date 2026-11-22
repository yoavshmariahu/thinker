// Reading a log a line at a time, without holding the file.
//
// Every log here is append-only and read whole by whoever wants a figure from it: the usage log, the proxy's,
// a repository's delivery journal. `fs.readFileSync(f, 'utf8').split('\n')` holds the file as a buffer, again as
// a string and again as an array of lines before the first row is parsed, so a 49 MB journal was a quarter of a
// gigabyte of memory to learn which pull requests it names -- and the hourly telemetry job read it once per
// checkout (2026-11-21: eleven of those jobs at once, 3 GB, on a 16 GB machine that ran out). A reader that only
// folds the rows into something small needs one chunk in memory at a time.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK = 1 << 16;

// `fn(line, index)` for every line of the file, in order; blank lines too, so an index is the line's number
// less one. A file that cannot be opened throws, as readFileSync did. `end`: read no further than this many
// bytes -- a reader that goes over the file twice sees the same lines both times, whatever was appended between.
export function eachLine(file, fn, { chunk = CHUNK, end = Infinity } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunk), dec = new StringDecoder('utf8');
    let rest = '', index = 0, n, at = 0;
    while (at < end && (n = fs.readSync(fd, buf, 0, Math.min(chunk, end - at), null)) > 0) {
      at += n;
      const text = rest + dec.write(buf.subarray(0, n));
      let start = 0, nl;
      while ((nl = text.indexOf('\n', start)) !== -1) { fn(text.slice(start, nl), index++); start = nl + 1; }
      rest = text.slice(start);
    }
    rest += dec.end();
    if (rest) fn(rest, index);
  } finally { fs.closeSync(fd); }
}

// The file's lines from the last one backwards, until `fn` returns true. Reads the end of the file first and
// only as far back as it has to: the last record of a journal is in its last few hundred bytes.
export function eachLineBackwards(file, fn, { chunk = CHUNK } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    let end = fs.fstatSync(fd).size, tail = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunk), buf = Buffer.allocUnsafe(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      // bytes, not text, are joined: a chunk may begin in the middle of a character, a line never does
      const bytes = Buffer.concat([buf, tail]);
      let stop = bytes.length;
      for (let i = bytes.length - 1; i >= 0; i--) {
        if (bytes[i] !== 10) continue;
        if (i + 1 < stop && fn(bytes.toString('utf8', i + 1, stop)) === true) return;
        stop = i;
      }
      tail = bytes.subarray(0, stop);
      end = start;
    }
    if (tail.length) fn(tail.toString('utf8'));
  } finally { fs.closeSync(fd); }
}
