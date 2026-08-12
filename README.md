# Job Application Automation

This project uses Playwright + TypeScript to:

- read the Simplify Summer 2026 Software Engineering Internship Roles table
- keep only `0d` and `1d` postings
- keep US and remote-compatible roles
- compare against the private Google Sheet in a real browser session
- skip jobs that already appear applied
- open new jobs and prefill supported ATS pages
- stop before final submit

## Run

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm start
```

## Notes

- The Google Sheet is private, so the script uses headed Playwright and your live Google login session.
- Playwright uses a dedicated Chrome profile at `playwright/.auth/` instead of your normal everyday Chrome profile.
- Learned answers are written to `data/answers.json` and `Q&A.md`.
- The script must never click a final submit button.
- The first run may require browser login and selector tuning on live ATS pages.
