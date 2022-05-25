# github-commit-push-file [![View Action](https://img.shields.io/badge/view-github%20action-yellow.svg)](https://github.com/marketplace/actions/github-commit-push-file) [![pipeline](https://img.shields.io/github/workflow/status/maxgfr/github-commit-push-file/build-test)](https://github.com/maxgfr/github-commit-push-file/actions/workflows/build.yaml)

`maxgfr/github-commit-push-file` is a [GitHub Action](https://github.com/features/actions) which lets you to commit and push a file to a repository.

## Usage

```yaml
name: 'action-test'
on:
  pull_request:
  push:

jobs:
  action:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Create a file
        run: |
          echo "GITHUB_SHA=${GITHUB_SHA}" >> sha.txt
      - name: Commit and push the file
        uses: maxgfr/github-commit-push-file@main
        with:
          commit_name: 'fix: add new line to sha.txt'
```

## Inputs

**Name**|**Type**|**Required**|**Description**
-----|-----|-----|-----
commit_name|string|yes|Name of the commit.
