# github-commit-push-file [![View Action](https://img.shields.io/badge/view-github%20action-yellow.svg)](https://github.com/marketplace/actions/github-commit-push-file) [![pipeline](https://img.shields.io/github/actions/workflow/status/maxgfr/github-commit-push-file/test-build.yml)](https://github.com/maxgfr/github-commit-push-file/actions/workflows/test-build.yml)

`maxgfr/github-commit-push-file` is a [GitHub Action](https://github.com/features/actions) which lets you commit and push files to a repository with advanced options like commit signing, custom author, and selective file staging.

## Features

- ✅ Commit and push files to a repository
- ✅ GPG commit signing support
- ✅ Custom author name and email
- ✅ Selective file staging (specific files or all)
- ✅ Target branch configuration
- ✅ Skip if no changes option
- ✅ Force push option
- ✅ Outputs for commit status and SHA

## Usage

### Basic Usage

```yaml
name: 'commit-and-push'
on:
  push:
    branches: [main]

jobs:
  action:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create a file
        run: echo "Hello World" >> hello.txt

      - name: Commit and push the file
        uses: maxgfr/github-commit-push-file@main
        with:
          commit_message: 'chore: add hello.txt'
```

### With Change Detection (Skip if No Changes)

This is useful for scheduled workflows where you only want to commit if there are actual changes:

```yaml
name: 'scheduled-update'
on:
  schedule:
    - cron: '0 0 * * *'

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run update script
        run: node ./scripts/update-data.js

      - name: Commit and push (if changes)
        uses: maxgfr/github-commit-push-file@main
        with:
          commit_message: 'chore: update data'
          files: 'data/output.json'
          skip_if_no_changes: 'true'
```

### With GPG Commit Signing

```yaml
name: 'signed-commit'
on:
  push:
    branches: [main]

jobs:
  action:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create a file
        run: echo "Signed content" >> signed.txt

      - name: Commit and push with signature
        uses: maxgfr/github-commit-push-file@main
        with:
          commit_message: 'chore: add signed file'
          sign_commit: 'true'
          gpg_private_key: ${{ secrets.GPG_PRIVATE_KEY }}
          gpg_passphrase: ${{ secrets.GPG_PASSPHRASE }}
```

### With Custom Author

```yaml
name: 'custom-author'
on:
  push:
    branches: [main]

jobs:
  action:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create a file
        run: echo "Bot content" >> bot.txt

      - name: Commit and push with custom author
        uses: maxgfr/github-commit-push-file@main
        with:
          commit_message: 'chore: automated update'
          author_name: 'My Bot'
          author_email: 'bot@example.com'
```

### Pushing to a Different Branch

```yaml
name: 'push-to-branch'
on:
  push:
    branches: [main]

jobs:
  action:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create a file
        run: echo "Feature content" >> feature.txt

      - name: Commit and push to feature branch
        uses: maxgfr/github-commit-push-file@main
        with:
          commit_message: 'feat: add feature file'
          branch: 'feature-branch'
          force_push: 'false'
```

### Using Outputs

```yaml
name: 'with-outputs'
on:
  push:
    branches: [main]

jobs:
  action:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create a file
        run: echo "Content" >> file.txt

      - name: Commit and push
        id: commit
        uses: maxgfr/github-commit-push-file@main
        with:
          commit_message: 'chore: add file'
          skip_if_no_changes: 'true'

      - name: Check if committed
        run: |
          if [ "${{ steps.commit.outputs.committed }}" == "true" ]; then
            echo "Commit was made with SHA: ${{ steps.commit.outputs.commit_sha }}"
          else
            echo "No changes were committed"
          fi
```

## Inputs

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `commit_message` | string | **yes** | - | The commit message |
| `files` | string | no | `-A` | Files to add (space-separated). Use `-A` for all files |
| `branch` | string | no | current branch | Target branch to push to |
| `author_name` | string | no | `GITHUB_ACTOR` | The name of the commit author |
| `author_email` | string | no | `GITHUB_ACTOR@users.noreply.github.com` | The email of the commit author |
| `sign_commit` | boolean | no | `false` | Whether to sign the commit with GPG |
| `gpg_private_key` | string | no | - | GPG private key (base64 encoded) for signing commits |
| `gpg_passphrase` | string | no | - | Passphrase for the GPG private key |
| `force_push` | boolean | no | `true` | Whether to force push |
| `skip_if_no_changes` | boolean | no | `false` | Skip commit and push if there are no changes |

### Deprecated Inputs

| Name | Type | Description |
|------|------|-------------|
| `commit_name` | string | **Deprecated**: Use `commit_message` instead |

## Outputs

| Name | Type | Description |
|------|------|-------------|
| `committed` | string | Whether a commit was made (`true` or `false`) |
| `commit_sha` | string | The SHA of the commit (empty if no commit was made) |

## GPG Signing Setup

To use GPG commit signing, you need to:

1. **Generate a GPG key** (if you don't have one):
   ```bash
   gpg --full-generate-key
   ```

2. **Export your private key** (base64 encoded):
   ```bash
   gpg --armor --export-secret-keys YOUR_KEY_ID | base64 -w 0
   ```

3. **Add the key to GitHub Secrets**:
   - Go to your repository settings
   - Navigate to Secrets and variables > Actions
   - Add `GPG_PRIVATE_KEY` with the base64-encoded key
   - Add `GPG_PASSPHRASE` with your key's passphrase (if any)

4. **Add the public key to your GitHub account**:
   - Export: `gpg --armor --export YOUR_KEY_ID`
   - Go to GitHub Settings > SSH and GPG keys > New GPG key
   - Paste the public key

## Migration from v1

If you're upgrading from an older version, note these changes:

- `commit_name` has been renamed to `commit_message` (the old name still works but is deprecated)
- New features: `files`, `branch`, `author_name`, `author_email`, `sign_commit`, `gpg_private_key`, `gpg_passphrase`, `force_push`, `skip_if_no_changes`
- New outputs: `committed`, `commit_sha`

## License

MIT
