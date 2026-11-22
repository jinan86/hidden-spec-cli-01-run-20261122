// mend: one command-line tool that applies AI-written edits, in four formats,
// to a tree of text files. Node 22, standard library only.
// Run as `node main.ts [options] [PATCH]`; SPEC.md is the whole contract.
//
// This file was written fresh for the hidden-spec-cli-01-run-20261122 entry:
// the command line, output and exit codes, safe paths, format detection,
// the three matching tiers, unified diffs, SEARCH/REPLACE blocks, V4A patches,
// JSON edits, and the all-or-nothing write.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to answer exit 2 with one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by one edit to report its failure; the edit changes nothing. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and no
 * empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with
 * `/`, holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file, split at its own line break. `final` says it ends with a break;
 * a file of no lines is written empty. */
interface ParsedFile {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): ParsedFile {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: ParsedFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the
 * rest read from disk; `moves` holds the move pairs of edits that succeeded. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** SPEC.md section 4: with `--format=auto` the format is the first that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** SPEC.md section 5: one line read at a tier (0 exact, 1 trailing space/tab
 * removed, 2 leading and trailing space/tab removed). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Every position where `oldLines` occurs in `lines` at `tier`, at or after
 * `from`; occurrences may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with `--strict`) at which
 * `oldLines` occurs in `lines` at or after `from`, with its positions. */
function firstTier(lines: string[], oldLines: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    const occ = occurrences(lines, oldLines, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Build the lines that replace a match: a context line (an N line whose index
 * `ctx` maps to an O index) is written as the file's own matched line, never
 * the patch's; at tier 2 every other line is re-indented from the old lines'
 * first line's leading whitespace to the file's first matched line's. */
function buildReplacement(fileLines: string[], pos: number, oldLines: string[], newLines: string[], ctx: Map<number, number>, tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 && oldLines.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const p = tier === 2 && oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  for (let j = 0; j < newLines.length; j++) {
    const oi = ctx.get(j);
    if (oi !== undefined) {
      out.push(fileLines[pos + oi]!);
      continue;
    }
    const line = newLines[j]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

/** Split a hunk or chunk body into its old lines O, its new lines N, and the
 * map from N indexes to O indexes for context lines. Body lines are ` ` or
 * empty (context), `-` (old), `+` (new); `\` lines mark no newline and add
 * nothing to either side. */
function splitBody(body: string[]): { o: string[]; n: string[]; ctx: Map<number, number> } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx = new Map<number, number>();
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push(t);
      ctx.set(n.length - 1, o.length - 1);
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push(l.slice(1));
    }
  }
  return { o, n, ctx };
}

/** Whether a `\` line follows the body's last context or `+` line: the new
 * content's last line then ends with no line break. */
function backslashAfterLastNew(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') last = k;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]![0] === '\\';
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** The old-file line number from the header (1-based). */
  a: number;
  body: string[];
  o: string[];
  n: string[];
  ctx: Map<number, number>;
  noEol: boolean;
  /** The `+` lines alone, for creations (section 6: a created file is the
   * `+` lines of all its hunks); plusNoEol says a `\` line follows the last
   * `+` line of this hunk. */
  plus: string[];
  plusNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  /** Set by a `---`/`+++` pair; rename lines name paths only without one. */
  hasPair: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A `--- ` line followed by a `+++ ` line starts (or continues) a section. */
function startsPair(lines: string[], i: number): boolean {
  return lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
}

/** The path a `--- ` or `+++ ` line names: the text after the four characters,
 * up to the first tab, with surrounding spaces removed; a leading `a/` or
 * `b/` is removed from either. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Read one hunk body starting after the header at `i`: the lines that start
 * with ` `, `-`, `+` or `\`, or are empty; it ends at the first other line, at
 * a `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at the
 * end of the patch; empty lines at the end of a body are not part of it. */
function readHunkBody(lines: string[], i: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (startsPair(lines, j)) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: j };
}

/** Whether a `\` line follows the body's last `+` line. */
function backslashAfterLastPlus(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]![0] === '+') last = k;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]![0] === '\\';
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, hasPair: false, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (startsPair(lines, i)) {
        const oldP = headerPath(l);
        const newP = headerPath(lines[i + 1]!);
        if (cur !== null && inHeader && !cur.hasPair) {
          cur.oldPath = oldP;
          cur.newPath = newP;
          cur.hasPair = true;
        } else {
          cur = { oldPath: oldP, newPath: newP, hasPair: true, isCreate: false, isDelete: false, hunks: [] };
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = readHunkBody(lines, i);
      const { o, n, ctx } = splitBody(body);
      const plus: string[] = [];
      for (const bl of body) if (bl[0] === '+') plus.push(bl.slice(1));
      cur.hunks.push({ a: Number(m[1]), body, o, n, ctx, noEol: backslashAfterLastNew(body), plus, plusNoEol: backslashAfterLastPlus(body) });
      inHeader = false;
      i = next;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ') && !cur.hasPair) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !cur.hasPair) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity
      // index`, `Index:` and any other line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => (tree) => applySection(tree, sec, strictFlag));
}

/** Apply one hunk to a file's parsed lines, in place. `d` is the sum over
 * this section's hunks applied so far of (N's length minus O's length). */
function applyHunk(f: ParsedFile, h: Hunk, d: number, strict: boolean, path: string): void {
  if (h.o.length > 0) {
    const found = firstTier(f.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const pos of found.occ) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const rep = buildReplacement(f.lines, best, h.o, h.n, h.ctx, found.tier);
    if (best + h.o.length === f.lines.length) f.final = !h.noEol;
    f.lines.splice(best, h.o.length, ...rep);
  } else {
    const at = Math.min(h.a + d, f.lines.length);
    if (at === f.lines.length) f.final = !h.noEol;
    f.lines.splice(at, 0, ...h.n);
  }
}

function applySection(tree: Tree, sec: Section, strict: boolean): void {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isCreate = sec.isCreate || oldP === '/dev/null';
  const isDelete = !isCreate && (sec.isDelete || newP === '/dev/null');
  const paths: string[] = [];
  if (isCreate) {
    if (newP !== null && newP !== '/dev/null') paths.push(newP);
  } else if (isDelete) {
    if (oldP !== null && oldP !== '/dev/null') paths.push(oldP);
  } else {
    if (oldP !== null && oldP !== '/dev/null') paths.push(oldP);
    if (newP !== null && newP !== '/dev/null' && newP !== oldP) paths.push(newP);
  }
  for (const p of paths) {
    if (!safe(p)) throw new Fail('unsafe', p);
  }
  if (isCreate) {
    const p = newP!;
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const plus: string[] = [];
    let plusNoEol = false;
    for (const h of sec.hunks) {
      plus.push(...h.plus);
      if (h.plus.length > 0) plusNoEol = h.plusNoEol;
    }
    let text = '';
    if (plus.length > 0) text = plus.join('\n') + (plusNoEol ? '' : '\n');
    tree.now.set(p, text);
    return;
  }
  if (isDelete) {
    const p = oldP!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  const p = oldP!;
  const cur = tree.get(p);
  if (cur === null) throw new Fail('missing', p);
  if (newP !== null && newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
  const f = parseFile(cur);
  let d = 0;
  for (const h of sec.hunks) {
    applyHunk(f, h, d, strict, p);
    d += h.n.length - h.o.length;
  }
  const text = renderFile(f);
  if (newP !== null && newP !== oldP) {
    tree.now.set(p, null);
    tree.now.set(newP, text);
    tree.moves.push({ old: p, nw: newP });
  } else {
    tree.now.set(p, text);
  }
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

/** Set by run() before the patch is read, so the edit closures below see the
 * `--strict` flag of this run. */
let strictFlag = false;

function parseSearchReplace(lines: string[]): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      j++;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    let k = eq + 1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let m = i - 1; m >= prevEnd; m--) {
      const cand = lines[m]!;
      if (blank(cand)) continue;
      const t = cand.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    prevPath = path;
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    const cur = tree.get(b.path);
    if (b.oldLines.length === 0) {
      if (cur !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    if (cur === null) throw new Fail('missing', b.path);
    const f = parseFile(cur);
    const found = firstTier(f.lines, b.oldLines, strictFlag);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const rep = buildReplacement(f.lines, pos, b.oldLines, b.newLines, new Map(), found.tier);
    f.lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, renderFile(f));
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  body: string[];
  o: string[];
  n: string[];
  ctx: Map<number, number>;
  eof: boolean;
}

const V4A_ADD = '*** Add File:';
const V4A_DELETE = '*** Delete File:';
const V4A_UPDATE = '*** Update File:';
const V4A_MOVE = '*** Move to:';

function v4aSectionStart(line: string): string | null {
  if (line.startsWith(V4A_ADD)) return 'add';
  if (line.startsWith(V4A_DELETE)) return 'delete';
  if (line.startsWith(V4A_UPDATE)) return 'update';
  return null;
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = v4aSectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(kind === 'add' ? V4A_ADD.length : kind === 'delete' ? V4A_DELETE.length : V4A_UPDATE.length).trim();
    const sectionLine = i + 1;
    i++;
    if (kind === 'add') {
      const rawStart = i;
      const raw: string[] = [];
      while (i < last && v4aSectionStart(lines[i]!) === null && lines[i]!.trim() !== '*** End Patch') {
        raw.push(lines[i]!);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl === '') fileLines.push('');
        else if (rl[0] === '+') fileLines.push(rl.slice(1));
        else throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      edits.push(((p, fl) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : `${fl.join('\n')}\n`);
      })(path, fileLines));
      continue;
    }
    if (kind === 'delete') {
      const raw: string[] = [];
      while (i < last && v4aSectionStart(lines[i]!) === null && lines[i]!.trim() !== '*** End Patch') {
        raw.push(lines[i]!);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      if (raw.length > 0) throw new Exit2(`error: parse ${i - raw.length + 1}`);
      edits.push(((p) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      continue;
    }
    // Update File section.
    let movePath: string | null = null;
    if (i < last && lines[i]!.startsWith(V4A_MOVE)) {
      movePath = lines[i]!.slice(V4A_MOVE.length).trim();
      i++;
    }
    const chunks: VChunk[] = [];
    let chunkOpen = false;
    let cur: VChunk | null = null;
    let afterEof = false;
    const closeChunk = (): void => {
      if (cur !== null) {
        const { o, n, ctx } = splitBody(cur.body);
        cur.o = o;
        cur.n = n;
        cur.ctx = ctx;
        chunks.push(cur);
        cur = null;
      }
      chunkOpen = false;
    };
    while (i < last) {
      const cl = lines[i]!;
      if (v4aSectionStart(cl) !== null || cl.trim() === '*** End Patch') break;
      if (cl.startsWith('@@')) {
        closeChunk();
        cur = { anchor: cl.slice(2).trim() === '' ? null : cl.slice(2).trim(), body: [], o: [], n: [], ctx: new Map(), eof: false };
        chunkOpen = true;
        afterEof = false;
        i++;
        continue;
      }
      if (cl.trim() === '*** End of File') {
        if (!chunkOpen || cur === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        closeChunk();
        afterEof = true;
        i++;
        continue;
      }
      if (cl === '' || cl[0] === ' ' || cl[0] === '-' || cl[0] === '+') {
        if (afterEof) throw new Exit2(`error: parse ${i + 1}`);
        if (!chunkOpen) {
          cur = { anchor: null, body: [], o: [], n: [], ctx: new Map(), eof: false };
          chunkOpen = true;
        }
        cur!.body.push(cl);
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    closeChunk();
    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1]!;
      while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
      const { o, n, ctx } = splitBody(lastChunk.body);
      lastChunk.o = o;
      lastChunk.n = n;
      lastChunk.ctx = ctx;
    }
    if (chunks.length === 0 && movePath === null) throw new Exit2(`error: parse ${sectionLine}`);
    edits.push(((p, mp, chs) => (tree: Tree) => applyV4aUpdate(tree, p, mp, chs))(path, movePath, chunks));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function applyV4aUpdate(tree: Tree, path: string, movePath: string | null, chunks: VChunk[]): void {
  if (!safe(path)) throw new Fail('unsafe', path);
  if (movePath !== null && !safe(movePath)) throw new Fail('unsafe', movePath);
  const cur = tree.get(path);
  if (cur === null) throw new Fail('missing', path);
  if (movePath !== null && tree.get(movePath) !== null) throw new Fail('exists', movePath);
  const f = parseFile(cur);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundIdx = -1;
      const max = strictFlag ? 0 : 2;
      for (let tier = 0; tier <= max && foundIdx < 0; tier++) {
        for (let k = cursor; k < f.lines.length; k++) {
          if (normLine(f.lines[k]!, tier) === normLine(ch.anchor!, tier)) {
            foundIdx = k;
            break;
          }
        }
      }
      if (foundIdx < 0) throw new Fail('no-match', path);
      cursor = foundIdx + 1;
    }
    if (ch.o.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      f.lines.splice(at, 0, ...ch.n);
      cursor = at + ch.n.length;
      continue;
    }
    let found: { tier: number; pos: number } | null = null;
    const max = strictFlag ? 0 : 2;
    for (let tier = 0; tier <= max && found === null; tier++) {
      for (const pos of occurrences(f.lines, ch.o, tier, cursor)) {
        if (ch.eof && pos + ch.o.length !== f.lines.length) continue;
        found = { tier, pos };
        break;
      }
    }
    if (found === null) throw new Fail('no-match', path);
    const rep = buildReplacement(f.lines, found.pos, ch.o, ch.n, ch.ctx, found.tier);
    f.lines.splice(found.pos, ch.o.length, ...rep);
    cursor = found.pos + rep.length;
  }
  const text = renderFile(f);
  if (movePath !== null) {
    tree.now.set(path, null);
    tree.now.set(movePath, text);
    tree.moves.push({ old: path, nw: movePath });
  } else {
    tree.now.set(path, text);
  }
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not a valid edit. A wrong
 * command or a missing or mistyped key is a parse fault. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const read = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = read(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = read(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running (SPEC.md sections 1, 2 and 10)                              */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  strictFlag = strict;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.get(mv.old);
    const wasNew = tree.original(mv.nw);
    const nowNew = tree.now.get(mv.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && nowNew !== undefined) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      consumed.add(mv.old);
      consumed.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (consumed.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const changed = rows.length;
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${changed} ${changed === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
