// Renders the repository index from data/repos.json, which the nightly
// workflow rebuilds (see scripts/build-index.mjs and SETUP.md), and adds a
// live filter on top. Cards are built as DOM nodes with textContent, never
// innerHTML, so README text can't inject markup. The one exception is the
// author bio modal, whose markdown is rendered by marked and sanitized by
// DOMPurify before it's inserted.
//
// The PDF pane (assets/pdf-reader.js) listens for clicks on #repo-list, so
// it works with these cards without any coordination.
(() => {
  'use strict';

  const DATA_URL = 'data/repos.json';
  // Hand-edited per-edition settings, e.g.
  // { editions: { "2026": { image: "…", description: "…" } } }.
  const EDITIONS_URL = 'data/editions.json';
  const EDITION_PREFIX = 'edition-';

  const repoList = document.getElementById('repo-list');
  const input = document.getElementById('repo-search');
  const status = document.getElementById('repo-search-status');
  const editionNav = document.getElementById('edition-nav');
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
  let editionSettings = {};
  let sectionSettings = {};

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

  function renderContributors(repo) {
    const line = el('p', { className: 'card-text small mb-0' });

    if (!repo.contributors?.length) {
      line.append(
        el('span', { className: 'text-body-secondary' }, [
          repo.contributorsOverflow ? 'Too many authors to list' : 'No authors listed',
        ])
      );
      return line;
    }

    repo.contributors.forEach((c, i) => {
      if (i > 0) line.append(', ');
      const displayName = c.name || `@${c.login}`;
      const link = el('a', { href: c.htmlUrl, className: 'd-inline-flex align-items-center gap-1 text-decoration-none' }, [
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
  // Author bio modal: the author's name as the h1, the repo's bio/*.md
  // rendered on the left, and the bio/ image on the right.
  // ---------------------------------------------------------------------

  function setBioMessage(text) {
    bioBody.replaceChildren(el('p', { className: 'text-body-secondary' }, [text]));
  }

  async function openBio(name, bio, repoTitle) {
    const token = ++bioRequestToken;
    bioTitle.textContent = name;
    bioImageCol.classList.toggle('d-none', !bio.imageUrl);
    bioContent.classList.toggle('col-md-7', Boolean(bio.imageUrl));
    bioByline.textContent = repoTitle ? `Author of ${repoTitle}` : '';
    if (bio.imageUrl) {
      bioImage.src = bio.imageUrl;
      bioImage.alt = `Photo of ${name}`;
    } else {
      bioImage.removeAttribute('src');
    }
    setBioMessage(bio.markdownUrl ? 'Loading bio…' : 'No bio available.');
    if (!bioModal.open) bioModal.showModal();
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
      if (!window.marked || !window.DOMPurify) throw new Error('markdown renderer not loaded');
      bioBody.innerHTML = window.DOMPurify.sanitize(window.marked.parse(markdown));
      window.MathJax?.typesetPromise?.([bioBody]).catch((err) => console.warn('MathJax typeset failed:', err));
    } catch (err) {
      if (token !== bioRequestToken) return;
      setBioMessage(`Could not load this bio (${err.message}).`);
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

    const authorNames = (repo.contributors || []).map((c) => c.name || `@${c.login}`).join(', ');

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

    const panel = el('div', { className: 'repo-panel', id: panelId, hidden: true }, [
      summary,
      renderContributors(repo),
      actions,
    ]);

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      panel.hidden = expanded;
      card.classList.toggle('is-expanded', !expanded);
    });

    const card = el('div', { className: 'repo-card' }, [
      el(`h${headingLevel}`, { className: 'repo-heading' }, [toggle]),
      panel,
    ]);
    card.dataset.repoName = repo.name;
    card.dataset.repoSearch = [
      repo.displayTitle,
      repo.name,
      repo.description || '',
      repo.summary || '',
      authorNames,
      editionLabel(topicSuffix(repo, EDITION_PREFIX)),
      sectionLabel(sectionKeyOf(repo)),
    ].join(' ').toLowerCase();
    return card;
  }

  // ---------------------------------------------------------------------
  // Grouping: repos are grouped by their first `edition-*` topic, then within
  // each edition by their first other topic (any topic not starting with
  // `edition-`). Repos missing either fall into an "Other" group at that level.
  // ---------------------------------------------------------------------

  // Returns what follows `prefix` in the repo's first topic starting with
  // it (e.g. "3" for "edition-3"), or null if it has no such topic.
  function topicSuffix(repo, prefix) {
    const topics = Array.isArray(repo.topics) ? repo.topics : [];
    for (const topic of topics) {
      const t = String(topic).toLowerCase();
      if (t.startsWith(prefix) && t.length > prefix.length) return t.slice(prefix.length);
    }
    return null;
  }

  // The repo's section: its first topic that isn't an `edition-*` topic,
  // or null if it has none.
  function sectionKeyOf(repo) {
    const topics = Array.isArray(repo.topics) ? repo.topics : [];
    for (const topic of topics) {
      const t = String(topic).toLowerCase();
      if (t && !t.startsWith(EDITION_PREFIX)) return t;
    }
    return null;
  }

  const humanizeSlug = (slug) =>
    slug
      .split('-')
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

  const editionLabel = (key) => (key == null ? 'Other repositories' : `Edition ${humanizeSlug(key)}`);

  const sectionLabel = (key) => (key == null ? 'Other' : humanizeSlug(key));

  // Numeric-aware compare, so "edition-10" sorts after "edition-9". Null keys
  // (the "Other" groups) always sort last.
  function compareKeys(a, b, descending) {
    if (a === b) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    const cmp = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    return descending ? -cmp : cmp;
  }

  // Returns [{ key, sections: [{ key, repos }] }], newest edition first and
  // sections alphabetical. Repos keep their order from repos.json.
  function groupRepos(repos) {
    const editions = new Map();
    for (const repo of repos) {
      const editionKey = topicSuffix(repo, EDITION_PREFIX);
      const sectionKey = sectionKeyOf(repo);
      if (!editions.has(editionKey)) editions.set(editionKey, new Map());
      const sections = editions.get(editionKey);
      if (!sections.has(sectionKey)) sections.set(sectionKey, []);
      sections.get(sectionKey).push(repo);
    }

    return [...editions.keys()]
      .sort((a, b) => compareKeys(a, b, true))
      .map((editionKey) => {
        const sections = editions.get(editionKey);
        return {
          key: editionKey,
          sections: [...sections.keys()]
            .sort((a, b) => compareKeys(a, b, false))
            .map((sectionKey) => ({ key: sectionKey, repos: sections.get(sectionKey) })),
        };
      });
  }

  const slugId = (prefix, key) => prefix + (key == null ? 'other' : key.replace(/[^a-z0-9-]/g, '-'));

  // Renders one edition group, laid out like a book page: the edition image (if
  // data/editions.json gives one) on the left, and on the right the edition
  // title, an article count, a short rule, the edition description, and the
  // section indexes. An edition whose repos all lack a section topic gets no
  // section headings, so its repo list sits directly under the description.
  function renderEdition(edition) {
    const editionId = slugId('edition-', edition.key);
    const showSections = !(edition.sections.length === 1 && edition.sections[0].key == null);
    const settings = (edition.key != null && editionSettings[edition.key]) || {};
    const repoCount = edition.sections.reduce((n, section) => n + section.repos.length, 0);

    const content = el('div', { className: 'col-12 edition-content' }, [
      el('h2', { className: 'edition-heading', id: editionId }, [editionLabel(edition.key)]),
      el('p', { className: 'edition-byline' }, [`${repoCount} ${repoCount === 1 ? 'article' : 'articles'}`]),
      el('hr', { className: 'edition-rule' }),
      settings.description ? el('p', { className: 'edition-description' }, [settings.description]) : null,
    ]);
    const group = el('section', { className: 'col-12 repo-group edition-group', 'aria-labelledby': editionId }, [
      el('div', { className: 'row g-4 g-md-5' }, [
        settings.image
          ? el('div', { className: 'col-12 col-md-5 edition-image-col' }, [
              el('img', { src: settings.image, className: 'edition-image', alt: '', loading: 'lazy' }),
            ])
          : null,
        content,
      ]),
    ]);
    if (settings.image) content.classList.add('col-md-7');

    for (const section of edition.sections) {
      const list = el('div', { className: 'repo-index' }, section.repos.map((repo) => {
        const card = renderCard(repo, showSections ? 4 : 3);
        cards.push(card);
        return card;
      }));

      if (!showSections) {
        content.append(list);
        continue;
      }
      const sectionId = `${editionId}--${slugId('section-', section.key)}`;
      const heading = el('h3', { className: 'section-heading', id: sectionId }, [sectionLabel(section.key)]);
      const color = section.key != null && sectionSettings[section.key]?.color;
      if (color && /^#[0-9a-f]{6}$/i.test(color)) {
        heading.prepend(el('span', { className: 'section-swatch', 'aria-hidden': 'true' }));
        heading.style.setProperty('--section-color', color);
      }
      content.append(
        el('section', { className: 'repo-group section-group', 'aria-labelledby': sectionId }, [heading, list])
      );
    }
    return group;
  }

  // One menu-bar link per edition, jumping to its heading.
  function renderEditionNav(editions) {
    if (!editionNav) return;
    editionNav.replaceChildren(...editions.map((edition) =>
      el('li', {}, [
        el('a', { href: `#${slugId('edition-', edition.key)}`, className: 'site-nav-link' }, [editionLabel(edition.key)]),
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

    // Hide any edition or section whose cards are all filtered out.
    for (const group of repoList.querySelectorAll('.repo-group')) {
      group.classList.toggle('d-none', !group.querySelector('.repo-card:not(.d-none)'));
    }
    // ...and its menu-bar link.
    for (const link of editionNav?.querySelectorAll('a') ?? []) {
      const group = document.querySelector(link.hash)?.closest('.edition-group');
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
    const editions = groupRepos(repos);
    repoList.replaceChildren(...editions.map(renderEdition));
    renderEditionNav(editions);

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

  // editions.json is optional: if it's missing or broken, the index still
  // renders, just without edition images.
  async function loadEditionSettings() {
    try {
      const data = await fetchJson(EDITIONS_URL);
      editionSettings = data?.editions || {};
      sectionSettings = data?.sections || {};
    } catch (err) {
      console.warn(`Could not load ${EDITIONS_URL}:`, err);
    }
  }

  async function init() {
    // Both requests start at once; the edition settings only need to be in
    // place before the cards render.
    const editionsLoaded = loadEditionSettings();
    try {
      const data = await fetchJson(DATA_URL);
      await editionsLoaded;
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
