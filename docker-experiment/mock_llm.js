#!/usr/bin/env node
import fs from 'node:fs';

const input = fs.readFileSync(0, 'utf8');

const notes = [
  {
    title: "Server initialization on port 8080",
    kind: "callpath",
    answers: [
      "how does the server start",
      "what port does the server run on",
      "where is startServer",
      "how to start the server"
    ],
    body: "server.js:startServer starts listening on port 8080 by default.",
    deps: [{ path: "server.js", symbol: "startServer" }],
    tags: ["server", "port", "startServer"],
    confidence: 0.85
  }
];

const assessments = [];

if (input.includes('"assessments"')) {
  process.stdout.write(JSON.stringify({ notes, assessments }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ notes }) + '\n');
}
