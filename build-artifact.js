#!/usr/bin/env node
/**
 * Builds the single-file version published as a Claude Artifact.
 *
 * index.html is the real page: a standard document that links styles.css and
 * app.js, which is what gets deployed as static hosting. The artifact host
 * works differently - it wraps whatever it is handed in its own
 * <!doctype html><head></head><body>, and its CSP will not load sibling
 * files - so the artifact build is a body fragment with the CSS and JS
 * inlined.
 *
 * One source of truth, two outputs. Run `node build-artifact.js` after
 * changing any of the three files, then publish dist/artifact.html.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = __dirname;
const read = f => fs.readFileSync(path.join(root, f), "utf8");

const html = read("index.html");
const css = read("styles.css");
const js = read("app.js");

function pick(re, what){
  const m = html.match(re);
  if (!m) throw new Error("index.html: could not find " + what);
  return m[0];
}

const title = pick(/<title>[\s\S]*?<\/title>/, "<title>");

// Google Fonts is the one external host the artifact CSP admits, so those
// links carry over verbatim. The favicon comes from the publish call instead,
// and styles.css is inlined below, so neither is copied.
const fonts = []
  .concat(html.match(/<link rel="preconnect"[^>]*>/g) || [])
  .concat(html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/g) || []);

if (!fonts.length) throw new Error("index.html: no font links found");

const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error("index.html: no <body>");

const body = bodyMatch[1]
  .replace(/[ \t]*<script src="app\.js"><\/script>[ \t]*\r?\n?/g, "")
  .trim();

// A literal </script> anywhere in the payload would close the tag early.
// Inside a JS string, regex or comment, <\/script> is equivalent and safe.
const guardJs = s => s.replace(/<\/script/gi, "<\\/script");

if (/<\/style/i.test(css)) throw new Error("styles.css contains </style>, which would close the tag early");

const out = [
  title,
  fonts.join("\n"),
  "",
  "<style>",
  css.trim(),
  "</style>",
  "",
  body,
  "",
  "<script>",
  guardJs(js.trim()),
  "</script>",
  ""
].join("\n");

const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const outPath = path.join(dist, "artifact.html");
fs.writeFileSync(outPath, out, "utf8");

console.log("built dist/artifact.html  " + (Buffer.byteLength(out) / 1024).toFixed(1) + " kB");
