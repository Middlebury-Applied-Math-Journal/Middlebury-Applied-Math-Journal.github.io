# Setup

This repository builds and publishes an index of every repository in the
Middlebury-Applied-Math-Journal organization. This file explains how it works and how to
set it up. Do not edit README.md or data/repos.json directly — a workflow
overwrites both on every run. index.html, assets/, site.json, and
data/editions.json are hand-maintained and safe to edit.

## How it works

1. A GitHub Actions workflow runs `scripts/build-index.mjs` on a schedule.
2. The script calls the GitHub API to list every repository in the
   Middlebury-Applied-Math-Journal organization, except this one.
3. For each repository, the script reads the top-level README and pulls out
   its first paragraph. If a repository has no README, the script falls
   back to the repository's short description on GitHub. If neither exists,
   the entry shows "No description available."
4. For each repository, the script reads the contributor list and removes
   bot accounts and `twoodwardMIDD`.
5. The script writes two files: `data/repos.json` (the data the website
   reads) and `README.md` (the same index, as shown on GitHub). If either
   changed, the workflow commits and pushes the update.
6. `index.html` is a static page. When someone visits it, `assets/index.js`
   fetches `data/repos.json` and renders the repo cards, filter, and math
   in the browser. Visitors never call the GitHub API, so there are no
   rate limits to worry about.

## Changing the page

Edit `index.html`, `assets/index.js` (card layout and filtering),
`assets/pdf-reader.js` (PDF pane), or `assets/style.css` directly and
push. Changes go live as soon as GitHub Pages redeploys — no rebuild
needed. To change the site title or description, edit `site.json`; it is
copied into `data/repos.json` on the next build. (The fallback title in
`index.html` is only shown if JavaScript is off.)

`data/repos.json` is also a stable endpoint other pages can use:
`https://middlebury-applied-math-journal.github.io/data/repos.json`.

## One-time setup

Do these steps once, after you push this repository to
`github.com/Middlebury-Applied-Math-Journal/Middlebury-Applied-Math-Journal.github.io`.

Give this one repository its own write access with a scoped token, rather
than changing the organization's default workflow permissions. The
organization's default (read-only) is a reasonable one to leave in place
for every other repo — this token grants write access to nothing but this
repository.

1. Create a fine-grained personal access token scoped to only the
   `Middlebury-Applied-Math-Journal.github.io` repository, with **Contents: Read and
   write** permission. (Settings > Developer settings > Personal access
   tokens > Fine-grained tokens.)
2. In this repository, open **Settings > Secrets and variables >
   Actions**.
3. Select **New repository secret**. Name it `INDEX_REPO_TOKEN` and paste
   the token as the value. The workflow already looks for a secret with
   this exact name and uses it automatically — no other configuration
   change is needed.
4. Open **Settings > Pages**.
5. Under **Build and deployment > Source**, select **Deploy from a
   branch**.
6. Under **Branch**, select `main` and `/ (root)`. Select **Save**.
7. Open the **Actions** tab.
8. Select **Build organization repository index** in the left sidebar.
9. Select **Run workflow** to trigger the first build by hand. Do not wait
   for the nightly schedule.
10. After the run finishes, open
    `https://middlebury-applied-math-journal.github.io/` to see the published page.

Reading the other repositories' READMEs and contributors doesn't need
`INDEX_REPO_TOKEN` — the workflow uses the default `GITHUB_TOKEN` for that,
which always has read access to public repository data regardless of the
organization's workflow permissions policy. `INDEX_REPO_TOKEN` is only
used for the final push back to this repository.

## Alternative: changing the organization's default instead

If you'd rather have every repository in the organization default to read
and write access (broader than this task needs, but simpler if you expect
other repos to need it too), an organization owner can change it at
`github.com/organizations/Middlebury-Applied-Math-Journal/settings/actions`, under
**Workflow permissions**. With that changed, `INDEX_REPO_TOKEN` becomes
unnecessary — the workflow falls back to the default `GITHUB_TOKEN`
automatically if the secret isn't set.

## Changing the schedule

Edit the `cron` line in `.github/workflows/build-index.yml`. The schedule
is in UTC. For example, `'0 12 * * *'` runs once at 12:00 UTC every day.
You can always trigger a build by hand from the Actions tab regardless of
the schedule.

## Grouping by edition and section

The page groups repositories using their GitHub topics:

- A topic starting with `edition-` puts the repository under that edition
  (`edition-3` → "Edition 3"). Editions are listed newest first, compared
  numerically, so `edition-10` comes before `edition-9`.
- Within an edition, any other topic (one not starting with `edition-`)
  puts the repository under that section (`root-finding` → "Root
  Finding"). Sections are listed alphabetically.
- A repository with no `edition-` topic is listed under "Other
  repositories" at the bottom; one with no other topic is listed
  under "Other" within its edition. An edition with no sections at all shows
  its repositories directly, without section headings.
- If a repository has more than one `edition-` topic, or more than one
  other topic, only the first of each in alphabetical order is used.

Topics are read during the nightly build, so a topic change shows up after
the next run (or a manual run of the workflow).

Each edition's image and description, and each section's color, are set in
`data/editions.json`. See "Organizing editions and sections" in README.md for
the format.

## Known limitations

- **README parsing is heuristic, not a full Markdown parser.** The script
  skips headings, horizontal rules, tables, and badge-only lines (like
  shields.io build badges), then takes the next paragraph. Unusual README
  layouts — for example, a paragraph that starts with an inline image, or
  heavy custom HTML — may need a tweak to `extractFirstParagraph()` in
  `scripts/build-index.mjs`.
- **Contributors come from commit history**, via GitHub's contributors API.
  This lists people who have committed code, not people who merely have
  repository access. A handful of repositories with unusually large
  contributor counts may show "too many to list" — GitHub's API declines to
  compute the full list for those.
- **All repositories are included**, including forks and archived
  repositories, with no filtering by topic or visibility.
- **This assumes every repository in the organization is public.** If any
  repository is private, the default `GITHUB_TOKEN` won't be able to read
  it, and the build log will show a warning for that repository (its
  README and contributors will be skipped, but it still appears in the
  index by name). To include private repositories, create a fine-grained
  personal access token with read access to the organization's
  repositories, add it as a repository secret (for example,
  `ORG_READ_TOKEN`), and change the `GITHUB_TOKEN` environment variable in
  `build-index.yml` to reference that secret instead of
  `secrets.GITHUB_TOKEN`.

## Running it locally

```
GITHUB_TOKEN=<a token with public repo read access> \
GITHUB_ORG=Middlebury-Applied-Math-Journal \
node scripts/build-index.mjs
```

This writes README.md and data/repos.json in place. To preview the page,
serve the folder over HTTP (opening index.html as a file won't work,
because browsers block `fetch()` from `file://` pages):

```
python3 -m http.server 8000
```

then open `http://localhost:8000/`.
