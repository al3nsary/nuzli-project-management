# GitHub Actions workflows (inactive)

These workflows live here instead of `.github/workflows/` because the token used to publish the repository has no `workflow` scope, and GitHub rejects pushes that touch `.github/workflows/` without it.

To activate them, push with a token that has the `workflow` scope, then:

```bash
mkdir -p .github/workflows
git mv infra/github-workflows/*.yml .github/workflows/
```

Until then the demo is deployed by pushing the built `apps/web/dist` to the `gh-pages` branch (see `scripts/publish-pages.sh`).
