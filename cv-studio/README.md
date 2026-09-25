# Folio

Folio is Glassline's external resume layer. It turns one real resume into a one-column, ATS-safe resume and can tailor that resume to a pasted job description.

Glassline stays the interview overlay. Choose **Folio** in Glassline to launch this program beside it.

```bash
node bin/cv-studio.js resume.txt [job.txt] [outDir]
```

The resume text uses labeled lines: `Name:`, `Email:`, `City:`, `Skills:`, `Experience: Employer | Title | YYYY-MM | YYYY-MM`, `Bullet:`, and `Education:`.

Set `CV_STUDIO_API_KEY` in `.env` only when a job description is long enough to tailor. Tests do not call the network.
