#!/usr/bin/env node
// Builds data/editions.json from the editions/ folders. Each folder is one
// edition, named for the part of its topic after `edition-` (editions/2026/
// for the topic `edition-2026`), and holds:
//
//   edition.json   description and the ordered list of sections with colors
//   cover.<ext>    image shown beside the edition
//   closing.<ext>  image shown after the edition's articles
//   editorial.md   editorial text, rendered as Markdown on the page
//
// Folders starting with `_` or `.` (such as editions/_template/) are skipped.
//
// Problems that would break the page (invalid JSON, a bad color, a duplicate
// section) are errors: the script prints them and exits without writing.
// Missing files and mismatches with the repository topics in data/repos.json
// are warnings: the edition is still built, without the missing parts.
//
// Run with `npm run build:editions`. No network access or dependencies needed.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDITIONS_DIR = 'editions';
const OUTPUT = path.join('data', 'editions.json');
const REPOS = path.join('data', 'repos.json');
const EDITION_PREFIX = 'edition-';

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];
const IMAGE_SLOTS = ['cover', 'closing'];
const EDITORIAL_FILE = 'editorial.md';
const SETTINGS_FILE = 'edition.json';
const KNOWN_SETTINGS = new Set(['description', 'sections']);
// GitHub topics: lowercase letters, digits and hyphens.
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
// WCAG minimum contrast for graphical objects such as the section swatch.
const MIN_SWATCH_CONTRAST = 3;
const PAGE_BACKGROUND = '#ffffff';

const errors = [];
const warnings = [];
const inActions = Boolean(process.env.GITHUB_ACTIONS);

function report(list, level, file, message) {
  list.push({ file, message });
  // In GitHub Actions, also emit an annotation so the problem shows up on
  // the workflow run summary next to the file.
  if (inActions) console.log(`::${level} file=${file}::${message}`);
}
const error = (file, message) => report(errors, 'error', file, message);
const warn = (file, message) => report(warnings, 'warning', file, message);

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(ROOT, file), 'utf-8'));
}

function parseSections(raw, file) {
  if (raw === undefined) {
    warn(file, 'No "sections" list. Articles in this edition will be listed alphabetically by section, with no colors.');
    return [];
  }
  if (!Array.isArray(raw)) {
    error(file, '"sections" must be a list, like [{ "key": "managing-energy", "color": "#2E7D32" }].');
    return [];
  }

  const sections = [];
  const seen = new Set();
  raw.forEach((entry, i) => {
    const where = `sections item ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      error(file, `${where} must be an object with "key" and "color".`);
      return;
    }
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    if (!key) {
      error(file, `${where} is missing "key", the section topic such as "managing-energy".`);
      return;
    }
    if (!TOPIC_PATTERN.test(key)) {
      error(file, `${where}: "${key}" is not a valid topic. Use lowercase letters, digits and hyphens, as GitHub topics do.`);
      return;
    }
    if (key.startsWith(EDITION_PREFIX)) {
      error(file, `${where}: "${key}" starts with "${EDITION_PREFIX}", so the page treats it as an edition, not a section.`);
      return;
    }
    if (seen.has(key)) {
      error(file, `Section "${key}" is listed more than once.`);
      return;
    }
    seen.add(key);

    const color = typeof entry.color === 'string' ? entry.color.trim() : '';
    if (!COLOR_PATTERN.test(color)) {
      error(file, `Section "${key}" needs a "color" written as a six-digit hex code such as "#2E7D32"${color ? `, not "${color}"` : ''}.`);
      return;
    }
    const ratio = contrastRatio(color, PAGE_BACKGROUND);
    if (ratio < MIN_SWATCH_CONTRAST) {
      warn(file, `Section "${key}" color ${color} is hard to see on the white page (contrast ${ratio.toFixed(2)}:1, aim for at least ${MIN_SWATCH_CONTRAST}:1).`);
    }
    for (const extra of Object.keys(entry)) {
      if (extra !== 'key' && extra !== 'color') warn(file, `Section "${key}" has an unknown setting "${extra}", which is ignored.`);
    }
    sections.push({ key, color });
  });
  return sections;
}

async function buildEdition(key, dir) {
  const files = await readdir(path.join(ROOT, dir));
  const edition = {};

  // edition.json
  const settingsFile = `${dir}/${SETTINGS_FILE}`;
  let settings = {};
  if (files.includes(SETTINGS_FILE)) {
    try {
      settings = await readJson(settingsFile);
    } catch (err) {
      error(settingsFile, `Not valid JSON: ${err.message}. Check for a missing quote, or a comma after the last item in a list.`);
      return null;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      error(settingsFile, 'Must be a JSON object, starting with { and ending with }.');
      return null;
    }
  } else {
    warn(dir, `No ${SETTINGS_FILE}. Copy the one from ${EDITIONS_DIR}/_template/.`);
  }
  for (const extra of Object.keys(settings)) {
    if (!KNOWN_SETTINGS.has(extra)) warn(settingsFile, `Unknown setting "${extra}", which is ignored.`);
  }
  if (typeof settings.description === 'string' && settings.description.trim()) {
    edition.description = settings.description.trim();
  } else if (settings.description !== undefined) {
    error(settingsFile, '"description" must be text in double quotes.');
  } else {
    warn(settingsFile, 'No "description".');
  }
  edition.sections = parseSections(settings.sections, settingsFile);

  // cover.* and closing.*
  for (const slot of IMAGE_SLOTS) {
    const matches = files.filter((f) => {
      const ext = path.extname(f).slice(1).toLowerCase();
      return path.basename(f, path.extname(f)).toLowerCase() === slot && IMAGE_EXTENSIONS.includes(ext);
    });
    if (matches.length > 1) {
      error(dir, `More than one ${slot} image (${matches.join(', ')}). Keep only one.`);
    } else if (matches.length === 1) {
      edition[slot] = `${dir}/${matches[0]}`;
    } else {
      warn(dir, `No ${slot} image. Add ${slot}.jpg (or .png, .webp) to this folder.`);
    }
  }

  // editorial.md
  if (files.includes(EDITORIAL_FILE)) {
    const text = (await readFile(path.join(ROOT, dir, EDITORIAL_FILE), 'utf-8')).trim();
    if (text) edition.editorial = text;
    else warn(`${dir}/${EDITORIAL_FILE}`, 'The editorial is empty.');
  } else {
    warn(dir, `No ${EDITORIAL_FILE}.`);
  }

  // Files that look like they were meant to be one of the above.
  for (const f of files) {
    const base = path.basename(f, path.extname(f)).toLowerCase();
    const expected = f === SETTINGS_FILE || f === EDITORIAL_FILE ||
      (IMAGE_SLOTS.includes(base) && IMAGE_EXTENSIONS.includes(path.extname(f).slice(1).toLowerCase()));
    if (!expected && !f.startsWith('.')) {
      warn(`${dir}/${f}`, `Not used. Expected only ${SETTINGS_FILE}, cover.jpg, closing.jpg and ${EDITORIAL_FILE}.`);
    }
  }

  return edition;
}

// Compares the editions/ folders with the topics on the article
// repositories in data/repos.json, so a typo in a topic or a section key is
// caught instead of silently showing an uncolored section.
async function checkAgainstTopics(editions) {
  let repos;
  try {
    repos = (await readJson(REPOS)).repos || [];
  } catch {
    return; // No index built yet: nothing to compare against.
  }
  const used = new Map(); // edition key -> Set of section keys
  for (const repo of repos) {
    const topics = (repo.topics || []).map((t) => String(t).toLowerCase());
    const edition = topics.find((t) => t.startsWith(EDITION_PREFIX) && t.length > EDITION_PREFIX.length);
    if (!edition) continue;
    const section = topics.find((t) => !t.startsWith(EDITION_PREFIX));
    const key = edition.slice(EDITION_PREFIX.length);
    if (!used.has(key)) used.set(key, new Set());
    if (section) used.get(key).add(section);
  }

  for (const [key, sectionsUsed] of used) {
    const edition = editions[key];
    if (!edition) {
      warn(EDITIONS_DIR, `Articles are tagged "${EDITION_PREFIX}${key}" but there is no ${EDITIONS_DIR}/${key}/ folder.`);
      continue;
    }
    const listed = new Set(edition.sections.map((s) => s.key));
    for (const section of sectionsUsed) {
      if (!listed.has(section)) {
        warn(`${EDITIONS_DIR}/${key}/${SETTINGS_FILE}`, `Articles in this edition use the section "${section}", which is not in "sections".`);
      }
    }
  }
}

async function main() {
  let entries;
  try {
    entries = await readdir(path.join(ROOT, EDITIONS_DIR), { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    entries = [];
  }

  const editions = {};
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const name of folders) {
    const dir = `${EDITIONS_DIR}/${name}`;
    if (!TOPIC_PATTERN.test(name)) {
      error(dir, `Folder name "${name}" can't match a topic. Use lowercase letters, digits and hyphens, such as "2026" for the topic "${EDITION_PREFIX}2026".`);
      continue;
    }
    const edition = await buildEdition(name, dir);
    if (edition) editions[name] = edition;
  }

  await checkAgainstTopics(editions);

  if (!inActions) {
    for (const w of warnings) console.warn(`warning  ${w.file}: ${w.message}`);
    for (const e of errors) console.error(`error    ${e.file}: ${e.message}`);
  }

  if (errors.length) {
    console.error(`\n${errors.length} error(s). ${OUTPUT} was not updated.`);
    process.exit(1);
  }

  const output = {
    note: `Generated by scripts/build-editions.mjs from the ${EDITIONS_DIR}/ folders. Do not edit by hand.`,
    editions,
  };
  await writeFile(path.join(ROOT, OUTPUT), JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${OUTPUT} with ${folders.length} edition(s) and ${warnings.length} warning(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
