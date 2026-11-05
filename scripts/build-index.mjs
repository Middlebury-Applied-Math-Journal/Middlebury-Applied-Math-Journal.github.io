#!/usr/bin/env node
// Builds the Middlebury-Applied-Math-Journal organization index data: data/repos.json
// (read by index.html in the browser) and README.md (the index as shown on
// GitHub). Run by .github/workflows/build-index.yml on a
// schedule, or manually with `node scripts/build-index.mjs`.
//
// Requires a GITHUB_TOKEN with read access to public repositories (the
// default Actions token is enough — see SETUP.md).

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ORG = process.env.GITHUB_ORG || 'Middlebury-Applied-Math-Journal';
const TOKEN = process.env.GITHUB_TOKEN;
// Contributors to leave out of the index (lowercase logins).
const EXCLUDED_LOGINS = new Set(['twoodwardmidd', 'woodwardtw']);
const userNameCache = new Map(); // login -> full name (or null), shared across repos
const API_BASE = 'https://api.github.com';
const MAX_PARAGRAPH_LENGTH = 320;

// The repo this workflow runs in is excluded from its own index.
const SELF_REPO_NAME = (process.env.GITHUB_REPOSITORY || `${ORG}/${ORG}.github.io`)
  .split('/')[1]
  .toLowerCase();

// Other repos to leave out of the index (lowercase names).
const EXCLUDED_REPOS = new Set([SELF_REPO_NAME, '.github']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

if (!TOKEN) {
  console.error('GITHUB_TOKEN is not set. See SETUP.md.');
  process.exit(1);
}

// ---------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------

async function ghRequest(url, { accept = 'application/vnd.github+json' } = {}) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `${ORG}-index-builder`,
    },
  });
}

// Follows the `Link: <url>; rel="next"` header to collect every page of a
// GitHub list endpoint.
async function ghPaginate(initialUrl) {
  const items = [];
  let url = initialUrl;
  while (url) {
    const res = await ghRequest(url);
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    const page = await res.json();
    items.push(...page);
    url = nextPageUrl(res.headers.get('link'));
  }
  return items;
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function listOrgRepos(org) {
  const url = `${API_BASE}/orgs/${encodeURIComponent(org)}/repos?type=all&per_page=100&sort=full_name&direction=asc`;
  return ghPaginate(url);
}

// Returns the README's raw text, or null if the repo has no README.
async function getReadmeText(owner, repo) {
  const res = await ghRequest(`${API_BASE}/repos/${owner}/${repo}/readme`);
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`  README fetch failed for ${owner}/${repo}: ${res.status}`);
    return null;
  }
  const json = await res.json();
  if (!json.content) return null;
  return Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf-8');
}

// Looks up a GitHub user's profile "name" (their full name, if they've set
// one — many users haven't). Cached across the whole run since the same
// person often contributes to more than one repo.
async function getUserFullName(login) {
  if (userNameCache.has(login)) return userNameCache.get(login);
  let name = null;
  try {
    const res = await ghRequest(`${API_BASE}/users/${encodeURIComponent(login)}`);
    if (res.ok) {
      const data = await res.json();
      name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
    }
  } catch (err) {
    console.warn(`  Could not fetch profile for ${login}: ${err.message}`);
  }
  userNameCache.set(login, name);
  return name;
}

// Returns { contributors, overflow } where contributors excludes bots and
// EXCLUDED_LOGINS, and overflow is true if GitHub declined to compute the
// full list (it does this for repos with very many contributors). Each
// contributor carries login, htmlUrl, avatarUrl, and name (their GitHub
// profile full name, or null if they haven't set one).
async function getContributors(owner, repo) {
  const url = `${API_BASE}/repos/${owner}/${repo}/contributors?per_page=100&anon=false`;
  try {
    const res = await ghRequest(url);
    if (res.status === 204) return { contributors: [], overflow: false }; // empty repo
    if (res.status === 403) return { contributors: [], overflow: true };
    if (!res.ok) {
      console.warn(`  Contributors fetch failed for ${owner}/${repo}: ${res.status}`);
      return { contributors: [], overflow: false };
    }
    const list = await ghPaginate(url);
    const filtered = list
      .filter((c) => c.type !== 'Bot' && c.login && !EXCLUDED_LOGINS.has(c.login.toLowerCase()))
      .sort((a, b) => b.contributions - a.contributions);

    const contributors = [];
    for (const c of filtered) {
      contributors.push({
        login: c.login,
        htmlUrl: c.html_url,
        avatarUrl: c.avatar_url,
        name: await getUserFullName(c.login),
      });
    }
    return { contributors, overflow: false };
  } catch (err) {
    console.warn(`  Contributors fetch errored for ${owner}/${repo}: ${err.message}`);
    return { contributors: [], overflow: false };
  }
}

// Returns the raw-content URL for a repo's PDF, or null if it has no
// top-level `pdf/` directory or that directory holds no `.pdf` file.
// Prefers a file named exactly `title.pdf`, falling back to the first
// PDF found. Raw GitHub content serves with `Access-Control-Allow-Origin:
// *`, so the browser can `fetch()` it directly (it just can't be framed,
// since raw.githubusercontent.com sends X-Frame-Options: deny).
async function getPdfUrl(owner, repo, defaultBranch) {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/pdf`;
  try {
    const res = await ghRequest(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`  pdf/ listing failed for ${owner}/${repo}: ${res.status}`);
      return null;
    }
    const listing = await res.json();
    if (!Array.isArray(listing)) return null; // pdf/ exists but isn't a directory
    const pdfFiles = listing.filter(
      (item) => item.type === 'file' && item.name.toLowerCase().endsWith('.pdf')
    );
    if (pdfFiles.length === 0) return null;
    const chosen = pdfFiles.find((item) => item.name.toLowerCase() === 'title.pdf') || pdfFiles[0];
    return `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/pdf/${chosen.name}`;
  } catch (err) {
    console.warn(`  pdf/ listing errored for ${owner}/${repo}: ${err.message}`);
    return null;
  }
}

// Returns raw-content URLs for a repo's author bio, from a top-level `bio/`
// directory: { markdownUrl, imageUrl, name }, any of which may be null (the
// first `.md` file, the first image found, and the text of the markdown's
// first heading). Returns null if there's no `bio/` directory or it holds
// neither file. index.js fetches the markdown when a visitor opens the bio
// modal, and uses `name` as the author when a repo has no contributors.
async function getBio(owner, repo, defaultBranch) {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/bio`;
  try {
    const res = await ghRequest(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`  bio/ listing failed for ${owner}/${repo}: ${res.status}`);
      return null;
    }
    const listing = await res.json();
    if (!Array.isArray(listing)) return null; // bio/ exists but isn't a directory
    const files = listing.filter((item) => item.type === 'file');
    const markdown = files.find((item) => /\.(md|markdown)$/i.test(item.name));
    const image = files.find((item) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(item.name));
    if (!markdown && !image) return null;
    const rawUrl = (item) =>
      item ? `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/bio/${item.name}` : null;
    const name = markdown ? await getBioName(markdown.url) : null;
    return { markdownUrl: rawUrl(markdown), imageUrl: rawUrl(image), name };
  } catch (err) {
    console.warn(`  bio/ listing errored for ${owner}/${repo}: ${err.message}`);
    return null;
  }
}

// Fetches a bio markdown file (by its contents-API URL) and returns the
// text of its first heading, e.g. "Megan Balparda" from "# Megan Balparda",
// or null if it can't be fetched or has no heading.
async function getBioName(contentsApiUrl) {
  try {
    const res = await ghRequest(contentsApiUrl, { accept: 'application/vnd.github.raw+json' });
    if (!res.ok) {
      console.warn(`  bio markdown fetch failed: ${res.status}`);
      return null;
    }
    return extractFirstHeading(await res.text());
  } catch (err) {
    console.warn(`  bio markdown fetch errored: ${err.message}`);
    return null;
  }
}

function extractFirstHeading(markdown) {
  if (!markdown) return null;
  const lines = stripFrontMatter(markdown).replace(/<!--[\s\S]*?-->/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const atx = trimmed.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    let heading = atx ? atx[1] : null;
    // Setext heading: a text line underlined with === or ---.
    if (!heading && trimmed && /^(=+|-+)\s*$/.test((lines[i + 1] || '').trim())) heading = trimmed;
    if (heading) {
      const text = toPlainText(heading);
      if (text) return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// README parsing: pull the first real paragraph out of a README's
// markdown, skipping front matter, headings, rules, tables, and
// badge/logo-only lines (e.g. shields.io build badges).
// ---------------------------------------------------------------------

function stripFrontMatter(markdown) {
  if (markdown.startsWith('---')) {
    const end = markdown.indexOf('\n---', 3);
    if (end !== -1) {
      const afterFence = markdown.indexOf('\n', end + 1);
      return afterFence === -1 ? '' : markdown.slice(afterFence + 1);
    }
  }
  return markdown;
}

function isSkippableLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (/^#{1,6}\s/.test(trimmed)) return true; // ATX heading
  if (/^(=+|-+)\s*$/.test(trimmed)) return true; // setext heading underline
  if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(trimmed)) return true; // hr
  if (/^\|/.test(trimmed)) return true; // table row
  if (/^<!--/.test(trimmed)) return true; // stray HTML comment marker

  // Badge / logo-only lines: strip every markdown image and link from the
  // line and see if anything meaningful is left.
  const withoutLinksAndImages = trimmed
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s+/g, '');
  if (trimmed.includes('![') && withoutLinksAndImages.length < 3) return true;

  return false;
}

function toPlainText(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/^>\s?/gm, '') // blockquote markers
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstParagraph(markdown) {
  if (!markdown) return null;
  const body = stripFrontMatter(markdown).replace(/<!--[\s\S]*?-->/g, '');
  const lines = body.split('\n');

  let paragraphLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (paragraphLines.length === 0) {
      if (isSkippableLine(line)) continue;
      paragraphLines.push(line);
    } else {
      if (line.trim() === '') break;
      paragraphLines.push(line);
    }
  }

  if (paragraphLines.length === 0) return null;
  const text = toPlainText(paragraphLines.join(' '));
  if (!text) return null;
  return text.length > MAX_PARAGRAPH_LENGTH
    ? `${text.slice(0, MAX_PARAGRAPH_LENGTH).trimEnd()}…`
    : text;
}

function humanize(text) {
  return text
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function titleCaseFromRepoName(name) {
  return humanize(name);
}

// Reads site.json for a human-editable site title and description. This
// file is never written by this script, so your edits persist across
// every scheduled rebuild. Falls back to a hyphen-free version of the org
// name, and no description, if the file is missing or a field is unset.
async function loadSiteConfig() {
  const defaults = { title: humanize(ORG), description: null };
  try {
    const raw = await readFile(path.join(ROOT, 'site.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      title:
        typeof parsed.title === 'string' && parsed.title.trim()
          ? parsed.title.trim()
          : defaults.title,
      description:
        typeof parsed.description === 'string' && parsed.description.trim()
          ? parsed.description.trim()
          : defaults.description,
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Could not read site.json, using defaults: ${err.message}`);
    }
    return defaults;
  }
}

// ---------------------------------------------------------------------
// Gather data for every repo
// ---------------------------------------------------------------------

async function buildRepoEntries() {
  console.log(`Listing repositories in ${ORG}...`);
  const rawRepos = (await listOrgRepos(ORG)).filter(
    (r) => !EXCLUDED_REPOS.has(r.name.toLowerCase())
  );
  rawRepos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  console.log(`Found ${rawRepos.length} repositories (excluding ${[...EXCLUDED_REPOS].join(', ')}).`);

  const entries = [];
  for (const repo of rawRepos) {
    console.log(`Processing ${repo.full_name}...`);
    const [readmeText, contributorInfo, pdfUrl, bio] = await Promise.all([
      getReadmeText(repo.owner.login, repo.name),
      getContributors(repo.owner.login, repo.name),
      getPdfUrl(repo.owner.login, repo.name, repo.default_branch),
      getBio(repo.owner.login, repo.name, repo.default_branch),
    ]);

    const firstParagraph = extractFirstParagraph(readmeText);

    entries.push({
      name: repo.name,
      displayTitle: titleCaseFromRepoName(repo.name),
      htmlUrl: repo.html_url,
      description: repo.description || null,
      summary: firstParagraph || repo.description || null,
      contributors: contributorInfo.contributors,
      contributorsOverflow: contributorInfo.overflow,
      isFork: repo.fork,
      isArchived: repo.archived,
      updatedAt: repo.pushed_at,
      // The org repo listing includes topics; index.js groups cards by the
      // `edition-*` topic and their first other topic (the section).
      topics: Array.isArray(repo.topics) ? repo.topics : [],
      pdfUrl,
      bio,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------
// Render README.md
// ---------------------------------------------------------------------

// Maintainer directions appended to every generated README. Edit them
// here, not in README.md.
const ORGANIZING_DIRECTIONS = [
  '## Organizing editions and sections',
  '',
  'The website groups articles into editions, and editions into sections. Two things control this: **topics** on each article repository decide where it goes, and **`data/editions.json`** in this repository holds the settings for each edition and section.',
  '',
  '### Topics: placing an article',
  '',
  'To add topics to an article repository:',
  '',
  '1. Open the repository on GitHub.',
  '2. Select the gear icon next to **About** on the right side of the page.',
  '3. Type each topic into the **Topics** field, pressing Enter after each one.',
  '4. Select **Save changes**.',
  '',
  'Use these topics:',
  '',
  '| Topic | Example | Shown as |',
  '| --- | --- | --- |',
  '| `edition-<name>` | `edition-2026` | Edition 2026 |',
  '| any other topic | `managing-energy` | Managing Energy (section) |',
  '',
  '- Editions are listed newest first. Numbers are compared as numbers, so `edition-10` comes before `edition-9`.',
  '- Sections are listed alphabetically within their edition.',
  '- A repository with no `edition-` topic is listed under **Other repositories** at the bottom of the page.',
  '- Any topic that does not start with `edition-` is used as the section. A repository with an edition but no other topic is listed under **Other** within that edition. If no repository in an edition has a section, the edition shows its articles without section headings.',
  '- Give each repository only one `edition-` topic and one other topic. If it has more, only the first of each in alphabetical order is used, so a repository tagged `fluids` and `pde` is placed in the Fluids section.',
  '- Topic changes appear after the next build. The build runs nightly, or you can run it now: open the **Actions** tab, select **Build organization repository index**, and select **Run workflow**.',
  '',
  '### `data/editions.json`: edition and section settings',
  '',
  'This file is edited by hand. The nightly build never overwrites it. The page reads it directly, so changes appear as soon as GitHub Pages redeploys, with no build needed.',
  '',
  '```json',
  '{',
  '  "editions": {',
  '    "2026": {',
  '      "image": "assets/images/sci.jpeg",',
  '      "description": "A short paragraph about the theme of this edition."',
  '    }',
  '  },',
  '  "sections": {',
  '    "managing-energy": {',
  '      "color": "#2E7D32"',
  '    }',
  '  }',
  '}',
  '```',
  '',
  '**Editions.** Each key under `"editions"` is the part of the topic after `edition-`. The topic `edition-2026` uses the key `"2026"`. Each edition can set:',
  '',
  '- `image`: a picture shown beside the edition. Add the image file to `assets/images/` and use its path, such as `"assets/images/cover.jpg"`. A full `https://` URL also works.',
  '- `description`: plain text shown under the edition title.',
  '',
  '**Sections.** Each key under `"sections"` is the section topic itself. The topic `managing-energy` uses the key `"managing-energy"`. Each section can set:',
  '',
  '- `color`: a color swatch shown beside the section heading. Any CSS color works, such as `"#2E7D32"` or `"teal"`.',
  '',
  'Every setting is optional. An edition or section with no entry is shown without an image, description, or color. Keep these rules in mind when you edit the file:',
  '',
  '- Write keys in lowercase, because GitHub stores topics in lowercase.',
  '- A section color applies to that section name in every edition.',
  '- The file must be valid JSON: wrap keys and values in double quotes, and do not leave a comma after the last item in a list. If the file is invalid, the page still loads but without any images, descriptions, or colors. The browser console shows the error.',
];

function renderReadme(entries, builtAt, site) {
  const lines = [];
  lines.push('<!-- AUTO-GENERATED by scripts/build-index.mjs — do not edit by hand.');
  lines.push('     Changes here are overwritten on the next scheduled run. -->');
  lines.push('');
  lines.push(`# ${site.title}`);
  lines.push('');
  if (site.description) {
    lines.push(site.description);
    lines.push('');
  }
  lines.push(
    `An automatically generated index of every repository in the [${ORG}](https://github.com/${ORG}) organization. Rebuilt nightly by [GitHub Actions](.github/workflows/build-index.yml). See [SETUP.md](SETUP.md) for how it works, and [Organizing editions and sections](#organizing-editions-and-sections) to place an article in an edition.`
  );
  lines.push('');
  lines.push(`_Last built: ${builtAt}_`);
  lines.push('');

  if (entries.length === 0) {
    lines.push('_No repositories found._');
  }

  for (const entry of entries) {
    lines.push(`## [${entry.displayTitle}](${entry.htmlUrl})`);
    lines.push('');
    if (entry.summary) {
      lines.push(entry.summary);
    } else {
      lines.push('_No description available._');
    }
    lines.push('');
    lines.push(`**Contributors:** ${formatContributorsMarkdown(entry)}`);
    lines.push('');
  }

  lines.push(...ORGANIZING_DIRECTIONS);
  lines.push('');

  return lines.join('\n');
}

function formatContributorsMarkdown(entry) {
  if (entry.contributors.length === 0) {
    if (entry.contributorsOverflow) return '_too many to list_';
    return entry.bio?.name || '_none listed_';
  }
  const names = entry.contributors.map((c) => `[@${c.login}](${c.htmlUrl})`).join(', ');
  return entry.contributorsOverflow ? `${names}, _and more_` : names;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  const site = await loadSiteConfig();
  const entries = await buildRepoEntries();
  const builtAt = new Date().toISOString();

  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await writeFile(path.join(ROOT, 'README.md'), renderReadme(entries, builtAt, site), 'utf-8');
  await writeFile(
    path.join(ROOT, 'data', 'repos.json'),
    JSON.stringify(
      { org: ORG, title: site.title, description: site.description, builtAt, repos: entries },
      null,
      2
    ),
    'utf-8'
  );

  console.log(`Wrote README.md and data/repos.json for ${entries.length} repositories.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
