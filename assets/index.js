// Renders the repository index from data/repos.json, which the nightly
// workflow rebuilds (see scripts/build-index.mjs and SETUP.md), and adds a
// live filter on top. Cards are built as DOM nodes with textContent, never
// innerHTML, so README text can't inject markup. The one exception is the
// reading modal (author bios and issue editorials), whose markdown is
// rendered by marked and sanitized by DOMPurify before it's inserted.
//
// The PDF pane (assets/pdf-reader.js) listens for clicks on #repo-list, so
// it works with these cards without any coordination.
(() => {
  'use strict';

  const DATA_URL = 'data/repos.json';
  // Per-issue settings, generated from the issues/ folders by
  // scripts/build-issues.mjs: { issues: { "2026": { description,
  // sections: [{ key, color }], cover, closing, editorial } } }.
  const ISSUES_URL = 'data/issues.json';
  const ISSUE_PREFIX = 'issue-';
  // Articles tagged before the rename to "issue" use `edition-*` topics;
  // they are read as the matching `issue-*` topic.
  const LEGACY_ISSUE_PREFIX = 'edition-';

  const repoList = document.getElementById('repo-list');
  const input = document.getElementById('repo-search');
  const status = document.getElementById('repo-search-status');
  const issueNav = document.getElementById('issue-nav');
  const noResults = document.getElementById('no-results');
  const siteTitle = document.getElementById('site-title');
  const siteDescription = document.getElementById('site-description');
  const builtAtEl = document.getElementById('built-at');
  const bioModal = document.getElementById('bio-modal');
  const bioTitle = document.getElementById('bio-modal-title');
  const bioBody = document.getElementById('bio-modal-body');
  const bioByline = document.getElementById('bio-modal-byline');
  const bioContent = document.getElementById('bio-modal-content');
  const bioImageCol = document.getElementById('bio-modal-image-col');
  const bioImage = document.getElementById('bio-modal-image');
  let bioRequestToken = 0;

  if (!repoList) return;

  let cards = [];
  let issueSettings = {};

  // Small element helper: el('a', { href: '…', className: '…' }, [children]).
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (key in node) {
        node[key] = value;
      } else {
        node.setAttribute(key, value);
      }
    }
    for (const child of children) {
      if (child == null) continue;
      node.append(child);
    }
    return node;
  }

  // Label plus a bordered cell holding a small diagonal arrow, for the
  // minimal outline buttons in an expanded repo row.
  function outlineBtnContent(label) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', '9');
    svg.setAttribute('height', '9');
    svg.setAttribute('viewBox', '0 0 9 9');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute(
      'd',
      'M1.27308 8.6948L6.64773 3.31482L6.63707 7.34714H8.38423V0.305237H1.34766L1.337 2.04174H5.37464L0 7.42171L1.27308 8.6948Z'
    );
    svg.append(path);
    return [
      el('span', { className: 'outline-btn-label' }, [label]),
      el('span', { className: 'outline-btn-icon' }, [svg]),
    ];
  }

  function avatarSrc(url) {
    try {
      const u = new URL(url);
      u.searchParams.set('s', '48');
      return u.toString();
    } catch {
      return url;
    }
  }

  // A repo's authors: its GitHub contributors or, when it has none (e.g.
  // every committer is an excluded maintainer), the name from the first
  // heading of its bio/*.md.
  function authorsOf(repo) {
    if (repo.contributors?.length) return repo.contributors;
    if (!repo.contributorsOverflow && repo.bio?.name) return [{ name: repo.bio.name }];
    return [];
  }

  function renderContributors(repo) {
    const line = el('p', { className: 'card-text small mb-0' });
    const authors = authorsOf(repo);

    if (!authors.length) {
      line.append(
        el('span', { className: 'text-body-secondary' }, [
          repo.contributorsOverflow ? 'Too many authors to list' : 'No authors listed',
        ])
      );
      return line;
    }

    authors.forEach((c, i) => {
      if (i > 0) line.append(', ');
      const displayName = c.name || `@${c.login}`;
      // A bio-only author has no GitHub profile: without a bio modal to
      // open, show the name as plain text.
      if (!c.htmlUrl && !(repo.bio && bioModal)) {
        line.append(el('span', {}, [displayName]));
        return;
      }
      const link = el('a', { href: c.htmlUrl || repo.bio?.markdownUrl || '#', className: 'd-inline-flex align-items-center gap-1 text-decoration-none' }, [
        c.avatarUrl
          ? el('img', {
              src: avatarSrc(c.avatarUrl),
              width: 20,
              height: 20,
              alt: '',
              loading: 'lazy',
            })
          : null,
        el('span', {}, [displayName]),
      ]);
      // With a bio/ directory, the link opens the bio modal instead of the
      // GitHub profile (which stays as the href for middle-click etc.).
      if (repo.bio && bioModal) {
        link.setAttribute('aria-haspopup', 'dialog');
        link.addEventListener('click', (e) => {
          e.preventDefault();
          openBio(displayName, repo.bio, repo.displayTitle);
        });
      }
      line.append(link);
    });
    if (repo.contributorsOverflow) {
      line.append(', ', el('span', { className: 'text-body-secondary' }, ['and more']));
    }
    return line;
  }

  // ---------------------------------------------------------------------
  // Reading modal, shared by author bios and issue editorials: a title
  // and byline, rendered markdown on the left, and an image on the right.
  // ---------------------------------------------------------------------

  function setBioMessage(text) {
    bioBody.replaceChildren(el('p', { className: 'text-body-secondary' }, [text]));
  }

  // Markdown is rendered by marked and sanitized by DOMPurify.
  function setBioMarkdown(markdown) {
    if (!window.marked || !window.DOMPurify) throw new Error('markdown renderer not loaded');
    bioBody.innerHTML = window.DOMPurify.sanitize(window.marked.parse(markdown));
    window.MathJax?.typesetPromise?.([bioBody]).catch((err) => console.warn('MathJax typeset failed:', err));
  }

  // Fills in the modal's title, byline and image, and opens it. Returns a
  // token; a slower request for an earlier modal checks it before writing.
  function showReadingModal({ title, byline, imageUrl, imageAlt }) {
    bioTitle.textContent = title;
    bioByline.textContent = byline || '';
    bioImageCol.classList.toggle('d-none', !imageUrl);
    bioContent.classList.toggle('col-md-7', Boolean(imageUrl));
    if (imageUrl) {
      bioImage.src = imageUrl;
      bioImage.alt = imageAlt || '';
    } else {
      bioImage.removeAttribute('src');
    }
    if (!bioModal.open) bioModal.showModal();
    return ++bioRequestToken;
  }

  async function openBio(name, bio, repoTitle) {
    const token = showReadingModal({
      title: name,
      byline: repoTitle ? `Author of ${repoTitle}` : '',
      imageUrl: bio.imageUrl,
      imageAlt: `Photo of ${name}`,
    });
    setBioMessage(bio.markdownUrl ? 'Loading bio…' : 'No bio available.');
    if (!bio.markdownUrl) return;

    try {
      const res = await fetch(bio.markdownUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const markdown = await res.text();
      if (token !== bioRequestToken) return;
      if (!markdown.trim()) {
        setBioMessage('No bio available.');
        return;
      }
      setBioMarkdown(markdown);
    } catch (err) {
      if (token !== bioRequestToken) return;
      setBioMessage(`Could not load this bio (${err.message}).`);
    }
  }

  // The issue's editorial.md, already inlined in data/issues.json by
  // scripts/build-issues.mjs, beside the issue's cover.
  function openEditorial(issueKey, settings) {
    showReadingModal({
      title: 'From the Editors',
      byline: settings.description
        ? `${issueLabel(issueKey)}: ${settings.description}`
        : issueLabel(issueKey),
      imageUrl: settings.cover,
      imageAlt: `Cover of ${issueLabel(issueKey)}`,
    });
    try {
      setBioMarkdown(settings.editorial);
    } catch (err) {
      setBioMessage(`Could not show the editorial (${err.message}).`);
    }
  }

  if (bioModal) {
    document.getElementById('bio-modal-close').addEventListener('click', () => bioModal.close());
    // A click on the dialog element itself (not its contents) is a click on
    // the backdrop.
    bioModal.addEventListener('click', (e) => {
      if (e.target === bioModal) bioModal.close();
    });
  }

  // Each repo is a compact row in its section's index: a toggle button
  // with the title and author names. Expanding it reveals the README
  // summary, the author line (with bio link), and the PDF/GitHub actions.
  function renderCard(repo, headingLevel) {
    const panelId = `repo-panel-${repo.name.replace(/[^a-z0-9-]/gi, '-')}`;

    const badges = [];
    if (repo.isArchived) badges.push(el('span', { className: 'badge text-bg-secondary' }, ['Archived']));
    if (repo.isFork) badges.push(el('span', { className: 'badge text-bg-secondary' }, ['Fork']));

    const authorNames = authorsOf(repo).map((c) => c.name || `@${c.login}`).join(', ');

    const toggle = el('button', {
      type: 'button',
      className: 'repo-toggle',
      'aria-expanded': 'false',
      'aria-controls': panelId,
    }, [
      el('span', { className: 'repo-toggle-title' }, [repo.displayTitle, ...badges.flatMap((b) => [' ', b])]),
      authorNames ? el('span', { className: 'repo-toggle-authors' }, [authorNames]) : null,
      el('span', { className: 'repo-toggle-icon', 'aria-hidden': 'true' }, [el('span')]),
    ]);

    const summary = repo.summary
      ? el('p', { className: 'card-text' }, [repo.summary])
      : el('p', { className: 'card-text' }, [
          el('span', { className: 'text-body-secondary' }, ['No description available.']),
        ]);

    const actions = el('div', { className: 'mt-3 d-flex flex-wrap gap-2' }, [
      repo.pdfUrl
        ? el('button', {
            type: 'button',
            className: 'outline-btn read-pdf-btn',
            'data-pdf-url': repo.pdfUrl,
            'data-pdf-title': repo.displayTitle,
          }, outlineBtnContent('Read the PDF'))
        : null,
      el('a', {
        href: repo.htmlUrl,
        className: 'outline-btn',
        target: '_blank',
        rel: 'noopener noreferrer',
      }, outlineBtnContent('View on GitHub')),
    ]);

    const panel = el('div', { className: 'repo-panel', id: panelId }, [
      summary,
      renderContributors(repo),
      actions,
    ]);

    // The wrapper animates open/closed in CSS (grid rows 0fr <-> 1fr),
    // driven by the card's is-expanded class.
    // The unpadded inner div is the grid item, so it can shrink to 0.
    const collapse = el('div', { className: 'repo-collapse' }, [
      el('div', { className: 'repo-collapse-inner' }, [panel]),
    ]);

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      card.classList.toggle('is-expanded', !expanded);
    });

    const card = el('div', { className: 'repo-card' }, [
      el(`h${headingLevel}`, { className: 'repo-heading' }, [toggle]),
      collapse,
    ]);
    card.dataset.repoName = repo.name;
    card.dataset.repoSearch = [
      repo.displayTitle,
      repo.name,
      repo.description || '',
      repo.summary || '',
      authorNames,
      issueLabel(topicSuffix(repo, ISSUE_PREFIX)),
      sectionLabel(sectionKeyOf(repo), topicSuffix(repo, ISSUE_PREFIX)),
    ].join(' ').toLowerCase();
    return card;
  }

  // ---------------------------------------------------------------------
  // Grouping: repos are grouped by their first `issue-*` topic, then within
  // each issue by their first other topic (any topic not starting with
  // `issue-`). Repos missing either fall into an "Other" group at that level.
  // ---------------------------------------------------------------------

  // The repo's topics, lowercased, with legacy `edition-*` topics read as
  // `issue-*`.
  function topicsOf(repo) {
    const topics = Array.isArray(repo.topics) ? repo.topics : [];
    return topics.map((topic) => {
      const t = String(topic).toLowerCase();
      return t.startsWith(LEGACY_ISSUE_PREFIX) ? ISSUE_PREFIX + t.slice(LEGACY_ISSUE_PREFIX.length) : t;
    });
  }

  // Returns what follows `prefix` in the repo's first topic starting with
  // it (e.g. "3" for "issue-3"), or null if it has no such topic.
  function topicSuffix(repo, prefix) {
    for (const t of topicsOf(repo)) {
      if (t.startsWith(prefix) && t.length > prefix.length) return t.slice(prefix.length);
    }
    return null;
  }

  // The repo's section: its first topic that isn't an `issue-*` topic,
  // or null if it has none.
  function sectionKeyOf(repo) {
    for (const t of topicsOf(repo)) {
      if (t && !t.startsWith(ISSUE_PREFIX)) return t;
    }
    return null;
  }

  const humanizeSlug = (slug) =>
    slug
      .split('-')
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

  const issueLabel = (key) => (key == null ? 'Other repositories' : `Issue ${humanizeSlug(key)}`);

  // A section's heading: its "title" from issue.json if set, otherwise
  // the topic made readable.
  const sectionLabel = (key, issueKey) => {
    if (key == null) return 'Other';
    const title = sectionsOf(issueKey).find((s) => s.key === key)?.title;
    return typeof title === 'string' && title ? title : humanizeSlug(key);
  };

  // Numeric-aware compare, so "issue-10" sorts after "issue-9". Null keys
  // (the "Other" groups) always sort last.
  function compareKeys(a, b, descending) {
    if (a === b) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    const cmp = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    return descending ? -cmp : cmp;
  }

  // Section order within an issue: sections listed in that issue's
  // issue.json come first, in the order they appear there; any others
  // follow alphabetically, and "Other" (null) is always last.
  const sectionsOf = (issueKey) =>
    (issueKey != null && Array.isArray(issueSettings[issueKey]?.sections)
      ? issueSettings[issueKey].sections
      : []);

  function compareSections(order, a, b) {
    const ia = a == null ? -1 : order.indexOf(a);
    const ib = b == null ? -1 : order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return compareKeys(a, b, false);
  }

  // Returns [{ key, sections: [{ key, repos }] }], newest issue first and
  // sections ordered by compareSections. Repos keep their order from
  // repos.json.
  function groupRepos(repos) {
    const issues = new Map();
    for (const repo of repos) {
      const issueKey = topicSuffix(repo, ISSUE_PREFIX);
      const sectionKey = sectionKeyOf(repo);
      if (!issues.has(issueKey)) issues.set(issueKey, new Map());
      const sections = issues.get(issueKey);
      if (!sections.has(sectionKey)) sections.set(sectionKey, []);
      sections.get(sectionKey).push(repo);
    }

    return [...issues.keys()]
      .sort((a, b) => compareKeys(a, b, true))
      .map((issueKey) => {
        const sections = issues.get(issueKey);
        const order = sectionsOf(issueKey).map((s) => s.key);
        return {
          key: issueKey,
          sections: [...sections.keys()]
            .sort((a, b) => compareSections(order, a, b))
            .map((sectionKey) => ({ key: sectionKey, repos: sections.get(sectionKey) })),
        };
      });
  }

  const slugId = (prefix, key) => prefix + (key == null ? 'other' : key.replace(/[^a-z0-9-]/g, '-'));

  // WCAG 2.2 relative luminance of a #rrggbb color.
  function relativeLuminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // Text color for a section block: white when it meets the WCAG AA
  // 4.5:1 ratio for normal text against the section color, else black.
  function sectionTextColor(bgHex) {
    const whiteContrast = 1.05 / (relativeLuminance(bgHex) + 0.05);
    return whiteContrast >= 4.5 ? '#ffffff' : '#000000';
  }

  // Button under the issue description that opens the editorial modal.
  function renderEditorialButton(issueKey, settings) {
    if (!bioModal) return null;
    const button = el('button', {
      type: 'button',
      className: 'outline-btn issue-editorial-btn',
      'aria-haspopup': 'dialog',
    }, outlineBtnContent('Editor\'s Note'));
    button.addEventListener('click', () => openEditorial(issueKey, settings));
    return el('p', { className: 'issue-editorial' }, [button]);
  }

  // Renders one issue group, laid out like a book page: the cover image (if
  // the issue's folder has one) on the left, and on the right the issue
  // title, an article count, a short rule, the issue description, a
  // button opening the editorial, the section indexes, and the closing image. An issue whose repos all lack a section topic gets no
  // section headings, so its repo list sits directly under the description.
  function renderIssue(issue) {
    const issueId = slugId('issue-', issue.key);
    const showSections = !(issue.sections.length === 1 && issue.sections[0].key == null);
    const settings = (issue.key != null && issueSettings[issue.key]) || {};
    const repoCount = issue.sections.reduce((n, section) => n + section.repos.length, 0);

    const content = el('div', { className: 'col-12 issue-content' }, [
      el('h2', { className: 'issue-heading', id: issueId }, [issueLabel(issue.key)]),
      el('p', { className: 'issue-byline' }, [`${repoCount} ${repoCount === 1 ? 'article' : 'articles'}`]),
      el('hr', { className: 'issue-rule' }),
      settings.description ? el('p', { className: 'issue-description' }, [settings.description]) : null,
      settings.editorial ? renderEditorialButton(issue.key, settings) : null,
    ]);
    const group = el('section', { className: 'col-12 repo-group issue-group', 'aria-labelledby': issueId }, [
      el('div', { className: 'row g-4 g-md-5' }, [
        settings.cover
          ? el('div', { className: 'col-12 col-md-5 issue-image-col' }, [
              el('img', { src: settings.cover, className: 'issue-image', alt: '', loading: 'lazy' }),
            ])
          : null,
        content,
      ]),
    ]);
    if (settings.cover) content.classList.add('col-md-7');
    const sectionColors = new Map(sectionsOf(issue.key).map((s) => [s.key, s.color]));

    for (const section of issue.sections) {
      const list = el('div', { className: 'repo-index' }, section.repos.map((repo) => {
        const card = renderCard(repo, showSections ? 4 : 3);
        cards.push(card);
        return card;
      }));

      if (!showSections) {
        content.append(list);
        continue;
      }
      const sectionId = `${issueId}--${slugId('section-', section.key)}`;
      const heading = el('h3', { className: 'section-heading', id: sectionId }, [sectionLabel(section.key, issue.key)]);
      const color = section.key != null && sectionColors.get(section.key);
      const sectionEl = el('section', { className: 'repo-group section-group', 'aria-labelledby': sectionId }, [heading, list]);
      if (color && /^#[0-9a-f]{6}$/i.test(color)) {
        // Set on the section so both the heading and the repo panels can use it.
        sectionEl.classList.add('has-section-color');
        sectionEl.style.setProperty('--section-color', color);
        sectionEl.style.setProperty('--section-fg', sectionTextColor(color));
      }
      content.append(sectionEl);
    }

    if (settings.closing) {
      content.append(
        el('figure', { className: 'issue-closing' }, [
          el('img', { src: settings.closing, className: 'issue-closing-image', alt: '', loading: 'lazy' }),
        ])
      );
    }
    return group;
  }

  // One menu-bar link per issue, jumping to its heading.
  function renderIssueNav(issues) {
    if (!issueNav) return;
    issueNav.replaceChildren(...issues.map((issue) =>
      el('li', {}, [
        el('a', { href: `#${slugId('issue-', issue.key)}`, className: 'site-nav-link' }, [issueLabel(issue.key)]),
      ])
    ));
  }

  function applyFilter() {
    const query = input ? input.value.trim().toLowerCase() : '';
    let visibleCount = 0;

    for (const card of cards) {
      const matches = query === '' || card.dataset.repoSearch.includes(query);
      card.classList.toggle('d-none', !matches);
      if (matches) visibleCount++;
    }

    // Hide any issue or section whose cards are all filtered out.
    for (const group of repoList.querySelectorAll('.repo-group')) {
      group.classList.toggle('d-none', !group.querySelector('.repo-card:not(.d-none)'));
    }
    // ...and its menu-bar link.
    for (const link of issueNav?.querySelectorAll('a') ?? []) {
      const group = document.querySelector(link.hash)?.closest('.issue-group');
      link.parentElement.classList.toggle('d-none', Boolean(group?.classList.contains('d-none')));
    }

    if (status) {
      status.textContent = `Showing ${visibleCount} of ${cards.length} repositories.`;
    }
    noResults?.classList.toggle('d-none', visibleCount !== 0 || cards.length === 0);
  }

  // MathJax loads with `defer`, so it may or may not be ready yet. If it
  // isn't, its own startup typeset will pick up the cards; if it is, typeset
  // them explicitly.
  function typesetMath() {
    window.MathJax?.startup?.promise
      ?.then(() => window.MathJax.typesetPromise([repoList]))
      .catch((err) => console.warn('MathJax typeset failed:', err));
  }

  function renderSite(data) {
    if (data.title) {
      if (siteTitle) siteTitle.textContent = data.title;
      document.title = `${data.title} — Repository Index`;
    }
    if (siteDescription) {
      siteDescription.textContent = data.description || '';
      siteDescription.classList.toggle('d-none', !data.description);
    }
    if (builtAtEl && data.builtAt) {
      builtAtEl.dateTime = data.builtAt;
      builtAtEl.textContent = new Date(data.builtAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    }

    const repos = Array.isArray(data.repos) ? data.repos : [];
    cards = [];
    const issues = groupRepos(repos);
    repoList.replaceChildren(...issues.map(renderIssue));
    renderIssueNav(issues);

    if (repos.length === 0 && status) {
      status.textContent = 'No repositories found.';
    } else {
      applyFilter();
    }
    if (input) input.disabled = false;
    typesetMath();
    // Lets assets/pdf-reader.js open a PDF named in the URL (?read=…).
    document.dispatchEvent(new CustomEvent('repos:rendered'));
  }

  async function fetchJson(url) {
    // `no-cache` revalidates with the server each visit, so a fresh nightly
    // build shows up immediately instead of waiting out the browser cache.
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // issues.json is optional: if it's missing or broken, the index still
  // renders, just without issue images, editorials, or section colors.
  async function loadIssueSettings() {
    try {
      const data = await fetchJson(ISSUES_URL);
      issueSettings = data?.issues || {};
    } catch (err) {
      console.warn(`Could not load ${ISSUES_URL}:`, err);
    }
  }

  async function init() {
    // Both requests start at once; the issue settings only need to be in
    // place before the cards render.
    const issuesLoaded = loadIssueSettings();
    try {
      const data = await fetchJson(DATA_URL);
      await issuesLoaded;
      renderSite(data);
    } catch (err) {
      console.error(`Could not load ${DATA_URL}:`, err);
      if (status) status.textContent = `Could not load the repository list (${err.message}).`;
      if (builtAtEl) builtAtEl.textContent = 'unknown';
    }
  }

  init();
  input?.addEventListener('input', applyFilter);
})();
