#!/usr/bin/env node
/**
 * bb.mjs - Blackboard course crawler / downloader / verifier (driven through browser CDP).
 *
 *   node bb.mjs resolve  --dir <workspace> --course-code 6244 --host https://your-bb.example.edu
 *   node bb.mjs crawl    --dir <workspace>
 *   node bb.mjs download --dir <workspace> [--dest course_content]
 *   node bb.mjs verify   --dir <workspace>
 *
 * Why Node: some Blackboard deployments reject the TLS handshake from Python's urllib while
 * Node's global fetch works. Why CDP: desktop hosts often embed a sidebar browser that is
 * view-only for an agent (no tools, downloads cancelled), so we borrow the user's own Edge
 * profile session instead and talk to it over the DevTools protocol.
 *
 * Cookies are never written to disk: the Cookie header lives in memory only.
 *
 * Environment overrides:
 *   BB_HOST              default host, e.g. https://bb.university.edu
 *   DSH_CDP_URL          CDP endpoint (default http://127.0.0.1:9222)
 *   PUPPETEER_CORE_PATH  explicit path to the puppeteer-core module
 *   PYTHON               python executable used to unpack course zips
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolvePuppeteer() {
  const tried = [];
  const candidates = [];
  if (process.env.PUPPETEER_CORE_PATH) candidates.push(process.env.PUPPETEER_CORE_PATH);
  if (process.env.DSH_HOME) candidates.push(path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules', 'puppeteer-core'));
  candidates.push('E:/DSH_HOME/profiles/desktop/node_modules/puppeteer-core'); // DSH desktop default install
  for (const c of candidates) {
    tried.push(c);
    try { return require(c); } catch { }
  }
  try { return require('puppeteer-core'); } catch { tried.push('puppeteer-core (node resolution)'); }
  throw new Error(`puppeteer-core not found - install it (npm i puppeteer-core) or set PUPPETEER_CORE_PATH.\nTried:\n  ${tried.join('\n  ')}`);
}

const puppeteer = resolvePuppeteer();

function resolvePython() {
  const candidates = [
    process.env.PYTHON, 'python', 'python3',
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'E:/DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ['-c', 'import zipfile'], { stdio: 'ignore' }); return c; } catch { }
  }
  return null;
}

const PYTHON = resolvePython();
const CDP_URL = process.env.DSH_CDP_URL || 'http://127.0.0.1:9222';
const DEFAULT_HOST = process.env.BB_HOST || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';
const STATE = '_bb_sync';
const MAX_DEPTH = 6;

// Blackboard chrome / non-content links that never carry course files.
const SKIP_HREF = [
  '#', 'javascript:', 'launchLink.jsp', 'announcement', 'discussion', 'gradebook', 'viewCalendar',
  'taskEdit', 'myEmailTool', 'userManager', 'addressBook', 'personalInfo', 'cmsmain/webui',
  'eltDelivery', 'listContentEditable', 'contextMenu', 'blank.jsp', 'uploadAssignment', 'mailto:',
];

const CT_EXT = {
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
  'text/html': '.html', 'text/csv': '.csv', 'text/plain': '.txt', 'text/x-python': '.py',
  'text/markdown': '.md', 'image/png': '.png', 'image/jpeg': '.jpg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.ms-powerpoint': '.ppt', 'application/msword': '.doc',
};

// ---------------------------------------------------------------- utilities

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(t);
  }
  return out;
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const sanitize = (s) => String(s).replace(/[<>:"/\\|?*\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || '_';
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1), 'utf8'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveDir(dir) {
  const ws = path.resolve(dir || '.');
  if (!fs.existsSync(ws)) throw new Error(`workspace not found: ${ws}`);
  return ws;
}

function statePaths(ws) {
  const s = path.join(ws, STATE);
  return {
    dir: s,
    course: path.join(s, 'course.json'),
    tree: path.join(s, 'tree.json'),
    results: path.join(s, 'results.json'),
    moves: path.join(s, 'moves.json'),
    verifyFetch: path.join(s, 'verify_fetch.json'),
    tmpZips: path.join(s, '_tmp_zips'),
  };
}

function parseDisposition(cd) {
  if (!cd) return null;
  let m = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i);
  if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { return m[1]; } }
  m = cd.match(/filename\*\s*=\s*(?:iso-8859-1|ISO-8859-1)''([^;]+)/i);
  if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { return m[1]; } }
  m = cd.match(/filename\s*=\s*"([^"]+)"/i);
  if (m) {
    let v = m[1];
    const b64 = v.match(/=\?utf-8\?B\?([^?]*)\?=/i);
    if (b64) { try { v = Buffer.from(b64[1], 'base64').toString('utf8'); } catch { } }
    return v;
  }
  m = cd.match(/filename\s*=\s*([^;]+)/i);
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}

function pickFilename(rec, headers, url, item, linkText) {
  const ct = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let name = parseDisposition(headers.get('content-disposition'));
  if (!name) {
    const seg = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (seg && /\.[a-z0-9]{1,5}$/i.test(seg) && !/^xid-\d+/i.test(seg)) name = seg;
  }
  if (!name) {
    const looksLikeFile = /\.[a-z0-9]{1,5}$/i.test(linkText || '');
    const base = looksLikeFile ? linkText : (item || 'file');
    const ext = CT_EXT[ct] || '';
    name = base + (ext && !new RegExp(`${ext.replace('.', '\\.')}$`, 'i').test(base) ? ext : '');
  }
  return sanitize(name);
}

// ---------------------------------------------------------------- CDP + HTTP

async function withBrowser(fn) {
  let browser;
  try { browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null }); }
  catch (e) {
    throw new Error(`cannot reach Edge CDP at ${CDP_URL} - run scripts/ensure-edge-cdp.ps1 first (${e.message})`);
  }
  const page = await browser.newPage();
  try { return await fn(browser, page); }
  finally {
    await page.close().catch(() => { });
    await browser.disconnect();
  }
}

async function cookieHeaderFor(page, host) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const { cookies } = await cdp.send('Network.getAllCookies');
  const hostname = new URL(host).hostname;
  const suffix = hostname.split('.').slice(-2).join('.');
  const picked = cookies.filter((c) => c.domain.endsWith(suffix) && !c.domain.startsWith('sts.'));
  if (!picked.length) throw new Error(`no cookies for ${suffix} - is the user logged in to Blackboard in Edge?`);
  return picked.map((c) => `${c.name}=${c.value}`).join('; ');
}

function makeHttp(ctx) {
  const headers = { cookie: ctx.cookie, 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' };
  return {
    async text(url, referer) {
      const res = await fetch(url, {
        headers: { ...headers, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...(referer ? { referer } : {}) },
        redirect: 'follow',
      });
      return { status: res.status, finalUrl: res.url, html: await res.text() };
    },
    async bytes(url, referer) {
      const res = await fetch(url, {
        headers: { ...headers, accept: '*/*', ...(referer ? { referer } : {}) },
        redirect: 'follow',
      });
      return { status: res.status, finalUrl: res.url, headers: res.headers, buf: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
    },
  };
}

async function parseListing(page, html, baseUrl) {
  return page.evaluate(({ h, baseUrl, skip }) => {
    const doc = new DOMParser().parseFromString(h, 'text/html');
    const out = { title: doc.title, items: [] };
    const cont = doc.querySelector('#content_listContainer');
    if (!cont) return out;
    cont.querySelectorAll(':scope > li').forEach((li) => {
      const h3 = li.querySelector('.item h3') || li.querySelector('h3');
      let title = h3 ? h3.innerText.replace(/\s+/g, ' ').trim() : '';
      if (!title) { const a = li.querySelector('a[href]'); title = a ? a.innerText.trim() : ''; }
      let desc = '';
      const gen = li.querySelector('.vtbegenerated');
      if (gen) desc = gen.innerText.replace(/[ \t]+\n/g, '\n').trim().slice(0, 8000);
      const anchors = [];
      li.querySelectorAll('a[href]').forEach((a) => {
        const raw = a.getAttribute('href');
        if (!raw || skip.some((s) => raw.startsWith(s) || raw.includes(s))) return;
        let abs; try { abs = new URL(raw, baseUrl).href; } catch { return; }
        if (skip.some((s) => abs.includes(s))) return;
        anchors.push({ text: a.innerText.replace(/\s+/g, ' ').trim(), href: abs });
      });
      out.items.push({ title, anchors, desc });
    });
    return out;
  }, { h: html, baseUrl, skip: SKIP_HREF });
}

async function parseMenu(page, html, baseUrl) {
  return page.evaluate(({ h, baseUrl }) => {
    const doc = new DOMParser().parseFromString(h, 'text/html');
    const out = [];
    doc.querySelectorAll('#courseMenu a[href], .courseMenu a[href], #courseMenu_link, a[href*="listContent.jsp"]').forEach((a) => {
      const raw = a.getAttribute('href');
      if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return;
      let abs; try { abs = new URL(raw, baseUrl).href; } catch { return; }
      out.push({ text: (a.innerText || '').replace(/\s+/g, ' ').trim(), href: abs });
    });
    return out;
  }, { h: html, baseUrl });
}

async function parseAllAnchors(page, html, baseUrl) {
  return page.evaluate(({ h, baseUrl }) => {
    const doc = new DOMParser().parseFromString(h, 'text/html');
    return [...doc.querySelectorAll('a[href]')].map((a) => {
      let abs = null;
      try { abs = new URL(a.getAttribute('href'), baseUrl).href; } catch { }
      return { text: (a.innerText || '').replace(/\s+/g, ' ').trim(), href: abs };
    }).filter((x) => x.href);
  }, { h: html, baseUrl });
}

// ---------------------------------------------------------------- crawl core

const CONTENT_ID_RE = /[?&]content_id=(_\d+_\d+)/;

async function crawlCourse(page, http, course) {
  const host = course.host;
  const launcher = `${host}/webapps/blackboard/execute/launcher?type=Course&id=${course.courseId}&url=`;
  const home = await http.text(launcher, `${host}/`);
  if (home.status !== 200) throw new Error(`course launcher returned HTTP ${home.status}`);
  if (/\/ultra\//.test(home.finalUrl)) {
    throw new Error('this course uses the Ultra experience (/ultra/...) - the listContent.jsp crawler does not apply; '
      + 'render the outline in the CDP page and collect attachment links from the DOM instead');
  }

  const menu = await parseMenu(page, home.html, home.finalUrl);
  const areas = [];
  const seenArea = new Set();
  for (const m of menu) {
    const cid = (m.href.match(CONTENT_ID_RE) || [])[1];
    if (!cid || seenArea.has(cid)) continue;
    seenArea.add(cid);
    areas.push({ title: m.text || `Area ${areas.length + 1}`, contentId: cid });
  }
  if (!areas.length) throw new Error('no content areas found in the course menu - is this course empty or a different Blackboard version?');

  const tree = [];
  const files = [];
  const visited = new Set();

  async function walk(contentId, folderPath, depth) {
    if (depth > MAX_DEPTH || visited.has(contentId)) return;
    visited.add(contentId);
    const url = `${host}/webapps/blackboard/content/listContent.jsp?course_id=${course.courseId}&content_id=${contentId}&mode=reset`;
    const res = await http.text(url, home.finalUrl);
    if (res.status !== 200) { console.error(`  ! HTTP ${res.status} for ${folderPath}`); return; }
    const parsed = await parseListing(page, res.html, res.finalUrl || url);
    const node = { path: folderPath, contentId, url, items: [] };
    for (const it of parsed.items) {
      const item = { title: it.title || '(untitled)', desc: it.desc, files: [], folders: [], links: [] };
      for (const a of it.anchors) {
        if (hostOf(a.href) !== hostOf(host)) { item.links.push(a.href); continue; }
        if (/bbcswebdav/.test(a.href)) {
          item.files.push({ href: a.href, linkText: a.text });
          files.push({ folder: folderPath, item: item.title, linkText: a.text, href: a.href });
          continue;
        }
        const cid = (a.href.match(CONTENT_ID_RE) || [])[1];
        if (cid) item.folders.push({ id: cid, title: a.text || item.title });
        else item.links.push(a.href);
      }
      item.kind = item.files.length ? 'file' : item.folders.length ? 'folder' : item.links.length ? 'link' : 'text';
      node.items.push(item);
    }
    tree.push(node);
    for (const it of node.items) {
      for (const f of it.folders) await walk(f.id, `${folderPath}/${sanitize(f.title)}`, depth + 1);
    }
  }

  for (const a of areas) await walk(a.contentId, a.title, 0);
  return { tree, files, areas, courseHome: home.finalUrl };
}

function printTree(tree, files) {
  for (const n of [...tree].sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`\n[${n.path}]`);
    for (const it of n.items) {
      if (!it.files.length && !it.folders.length && !it.links.length) continue;
      console.log(`  <${it.kind}> ${it.title}`);
      for (const f of it.files) console.log(`      FILE ${f.linkText || '(no anchor text)'}`);
      for (const f of it.folders) console.log(`      DIR  ${f.title}`);
      for (const l of it.links) console.log(`      LINK ${l}`);
    }
  }
  console.log(`\nareas: ${tree.length} page(s), attachments: ${files.length}`);
}

// ---------------------------------------------------------------- commands

async function cmdResolve(a) {
  const ws = resolveDir(a.dir);
  const host = (a.host || DEFAULT_HOST).replace(/\/+$/, '');
  if (!host) throw new Error('Blackboard host is required: pass --host https://bb.your-university.edu (or set BB_HOST)');
  const code = String(a['course-code'] || a.code || '').trim();
  if (!code) throw new Error('--course-code is required, e.g. --course-code 6244');

  return withBrowser(async (_browser, page) => {
    const cookie = await cookieHeaderFor(page, host);
    const http = makeHttp({ cookie });
    const home = await http.text(`${host}/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1`, `${host}/`);
    if (!/Welcome|Logout|Global Menu/i.test(home.html) || /\/webapps\/login\/?/.test(home.finalUrl)) {
      throw new Error('not logged in to Blackboard in this Edge profile - open Blackboard in the Edge window and log in, then rerun');
    }
    const anchors = await parseAllAnchors(page, home.html, home.finalUrl);
    const courses = [];
    const seen = new Set();
    for (const x of anchors) {
      if (!/launcher\?type=Course/i.test(x.href)) continue;
      const id = (x.href.match(/[?&]id=(_\d+_\d+)/) || [])[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      courses.push({ courseId: id, name: x.text });
    }
    if (!courses.length) throw new Error('no launcher links found on the Home tab - open "My Courses" in Edge and rerun');
    console.log('enrolled courses:');
    for (const c of courses) console.log(`  ${c.courseId.padEnd(12)} ${c.name}`);
    const lower = code.toLowerCase();
    const hit = courses.find((c) => c.name.toLowerCase().includes(lower))
      || courses.find((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(lower.replace(/[^a-z0-9]/g, '')));
    if (!hit) throw new Error(`no course matched "${code}" - pick one of the ids above and rerun resolve with a closer code`);
    const record = { host, code, courseId: hit.courseId, name: hit.name, resolvedAt: new Date().toISOString() };
    writeJSON(statePaths(ws).course, record);
    console.log(`\nmatched: ${hit.courseId}  ${hit.name}`);
    console.log(`saved   : ${path.relative(ws, statePaths(ws).course)}`);
  });
}

async function cmdCrawl(a) {
  const ws = resolveDir(a.dir);
  const sp = statePaths(ws);
  if (!fs.existsSync(sp.course)) throw new Error('run `bb.mjs resolve` first');
  const course = readJSON(sp.course);

  return withBrowser(async (_browser, page) => {
    const cookie = await cookieHeaderFor(page, course.host);
    const http = makeHttp({ cookie });
    const { tree, files, areas, courseHome } = await crawlCourse(page, http, course);
    printTree(tree, files);
    writeJSON(sp.tree, { generatedAt: new Date().toISOString(), course, courseHome, areas, tree, files });
    console.log(`saved: ${path.relative(ws, sp.tree)}`);
  });
}

function indexWorkspace(ws, skipDirs) {
  const byHash = new Map();
  const byName = new Map();
  const byNameList = new Map();
  const dirNames = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        dirNames.add(e.name.toLowerCase());
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const p = path.join(dir, e.name);
        try {
          const buf = fs.readFileSync(p);
          const rel = path.relative(ws, p).replace(/\\/g, '/');
          const h = md5(buf);
          if (!byHash.has(h)) byHash.set(h, rel);
          const key = e.name.toLowerCase();
          if (!byNameList.has(key)) byNameList.set(key, []);
          byNameList.get(key).push({ rel, size: buf.length });
          byName.set(key, byName.get(key) || []);
        } catch { }
      }
    }
  };
  walk(ws);
  return { byHash, byNameList, dirNames };
}

async function cmdDownload(a) {
  const ws = resolveDir(a.dir);
  const sp = statePaths(ws);
  if (!fs.existsSync(sp.tree)) throw new Error('run `bb.mjs crawl` first');
  const manifest = readJSON(sp.tree);
  const course = manifest.course;
  const dest = a.dest || 'course_content';
  const destDir = path.join(ws, dest);

  return withBrowser(async (_browser, page) => {
    const cookie = await cookieHeaderFor(page, course.host);
    const http = makeHttp({ cookie });
    const idx = indexWorkspace(ws, new Set(['node_modules', '.git', STATE]));
    console.log(`existing files indexed: ${idx.byHash.size} unique hashes`);
    const referer = `${course.host}/webapps/blackboard/content/listContent.jsp?course_id=${course.courseId}`;

    const results = [];
    const runHashes = new Map();
    const stats = { downloaded: 0, skipped: 0, extracted: 0, error: 0 };

    for (const node of manifest.tree) {
      for (const item of node.items) {
        for (const f of item.files || []) {
          const rec = {
            folder: node.path, item: item.title, url: f.href, linkText: f.linkText,
            status: '', file: '', reason: '', bytes: 0, md5: '', filename: '',
          };
          try {
            const res = await http.bytes(f.href, referer);
            if (!res.buf) { rec.status = 'error'; rec.reason = `HTTP ${res.status}`; stats.error++; results.push(rec); console.error(`  ! ${res.status} ${f.linkText}`); continue; }
            rec.bytes = res.buf.length;
            rec.md5 = md5(res.buf);
            rec.filename = pickFilename(rec, res.headers, res.finalUrl || f.href, item.title, f.linkText);

            if (runHashes.has(rec.md5)) { rec.status = 'skipped-duplicate-in-course'; rec.reason = runHashes.get(rec.md5); stats.skipped++; results.push(rec); console.log(`  = course dup  ${rec.filename}`); continue; }
            if (idx.byHash.has(rec.md5)) { rec.status = 'skipped-already-in-workspace'; rec.reason = idx.byHash.get(rec.md5); stats.skipped++; results.push(rec); console.log(`  = in workspace ${rec.filename}  <- ${rec.reason}`); continue; }
            const sameName = (idx.byNameList.get(rec.filename.toLowerCase()) || []).find((x) => x.size === rec.bytes);
            if (sameName) { rec.status = 'skipped-already-in-workspace'; rec.reason = sameName.rel; stats.skipped++; results.push(rec); console.log(`  = in workspace ${rec.filename}  <- ${sameName.rel}`); continue; }
            if (/\.zip$/i.test(rec.filename) && idx.dirNames.has(path.basename(rec.filename, '.zip').toLowerCase())) {
              rec.status = 'skipped-already-in-workspace';
              rec.reason = `extracted folder "${path.basename(rec.filename, '.zip')}" already exists`;
              stats.skipped++; results.push(rec); console.log(`  = extracted dir ${rec.filename}`); continue;
            }

            const outDir = path.join(destDir, ...node.path.split('/').map(sanitize));
            fs.mkdirSync(outDir, { recursive: true });
            let outPath = path.join(outDir, rec.filename);
            let n = 1;
            while (fs.existsSync(outPath)) { const ext = path.extname(rec.filename); outPath = path.join(outDir, `${path.basename(rec.filename, ext)} (${n++})${ext}`); }

            if (/\.zip$/i.test(rec.filename)) {
              if (!PYTHON) throw new Error('a python interpreter with the zipfile module is required to unpack course zips - set PYTHON to one, or skip zips by renaming them');
              const tmp = `${outPath}.part`;
              fs.writeFileSync(tmp, res.buf);
              const target = outPath.replace(/\.zip$/i, '');
              fs.mkdirSync(target, { recursive: true });
              execFileSync(PYTHON, ['-c', 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', tmp, target], { stdio: 'pipe' });
              fs.unlinkSync(tmp);
              rec.status = 'downloaded-extracted';
              rec.file = `${path.relative(ws, target).replace(/\\/g, '/')}/`;
              stats.extracted++;
              console.log(`  + extracted   ${rec.file}`);
            } else {
              fs.writeFileSync(outPath, res.buf);
              rec.status = 'downloaded';
              rec.file = path.relative(ws, outPath).replace(/\\/g, '/');
              stats.downloaded++;
              console.log(`  + ${rec.file}  (${(rec.bytes / 1024).toFixed(1)} KB)`);
            }
            runHashes.set(rec.md5, rec.file || rec.filename);
          } catch (e) {
            rec.status = 'error';
            rec.reason = e.message;
            stats.error++;
            console.error(`  ! ${item.title} / ${f.linkText}: ${e.message}`);
          }
          results.push(rec);
        }
      }
    }

    writeJSON(sp.results, results);
    console.log(`\nsummary: ${stats.downloaded} downloaded, ${stats.extracted} extracted, ${stats.skipped} skipped, ${stats.error} errors  (total ${results.length})`);
    console.log(`saved  : ${path.relative(ws, sp.results)}`);
  });
}

async function cmdVerify(a) {
  const ws = resolveDir(a.dir);
  const sp = statePaths(ws);
  if (!fs.existsSync(sp.results)) throw new Error('run `bb.mjs download` first');
  const stored = readJSON(sp.results);
  const manifest = readJSON(sp.tree);
  const course = manifest.course;

  return withBrowser(async (_browser, page) => {
    const cookie = await cookieHeaderFor(page, course.host);
    const http = makeHttp({ cookie });

    console.log('re-crawling course structure...');
    const fresh = await crawlCourse(page, http, course);
    const liveSet = new Set(fresh.files.map((f) => f.href));
    const storedSet = new Set(stored.map((r) => r.url));
    const gone = stored.filter((r) => !liveSet.has(r.url));
    const added = fresh.files.filter((f) => !storedSet.has(f.href));
    console.log(`live attachments: ${fresh.files.length}   stored: ${stored.length}`);
    console.log(`stored but no longer on the site: ${gone.length}`);
    for (const g of gone) console.log(`  - ${g.url}`);
    console.log(`on the site but not in the crawl/archive: ${added.length}`);
    for (const n of added) console.log(`  + ${n.folder} | ${n.item} | ${n.linkText}`);

    fs.mkdirSync(sp.tmpZips, { recursive: true });
    const referer = `${course.host}/webapps/blackboard/content/listContent.jsp?course_id=${course.courseId}`;
    const out = [];
    let changed = 0;
    let i = 0;
    for (const r of stored) {
      i++;
      const res = await http.bytes(r.url, referer);
      if (!res.buf) { out.push({ url: r.url, item: r.item, ok: false, why: `HTTP ${res.status}` }); continue; }
      const now = md5(res.buf);
      const same = now === r.md5;
      if (!same) { changed++; console.log(`  ~ changed since crawl: ${r.filename || r.item}`); }
      const rec = {
        url: r.url, item: r.item, folder: r.folder, filename: r.filename, status: r.status,
        file: r.file, reason: r.reason, storedMd5: r.md5, liveMd5: now,
        bytesStored: r.bytes, bytesLive: res.buf.length, unchangedSinceCrawl: same, zipPath: null,
      };
      const likelyZip = /\.zip$/i.test(r.filename || '') || /\(zip\)/i.test(r.item || '') || /\.zip$/i.test(r.file || '');
      if (likelyZip) {
        const zp = path.join(sp.tmpZips, `${String(i).padStart(2, '0')}_${sanitize(r.filename || 'package.zip')}`);
        fs.writeFileSync(zp, res.buf);
        rec.zipPath = zp;
      }
      out.push(rec);
      process.stdout.write('.');
    }
    console.log(`\nfetched ${out.length}; changed since crawl: ${changed}; fetch errors: ${out.filter((x) => x.ok === false).length}`);
    writeJSON(sp.verifyFetch, out);
    console.log(`saved: ${path.relative(ws, sp.verifyFetch)}`);
    if (added.length || gone.length) console.log('NOTE: the course changed since the archive was built; re-run download then verify.');
  });
}

// ---------------------------------------------------------------- entry

const USAGE = `usage:
  node bb.mjs resolve  --dir <workspace> --course-code <code> [--host <url>]
  node bb.mjs crawl    --dir <workspace>
  node bb.mjs download --dir <workspace> [--dest course_content]
  node bb.mjs verify   --dir <workspace>`;

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || !['resolve', 'crawl', 'download', 'verify'].includes(cmd)) { console.log(USAGE); process.exit(2); }
  if (cmd === 'resolve') await cmdResolve(a);
  else if (cmd === 'crawl') await cmdCrawl(a);
  else if (cmd === 'download') await cmdDownload(a);
  else await cmdVerify(a);
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
