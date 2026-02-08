# github-commit-push-file [![View Action](https://img.shields.io/badge/view-github%20action-yellow.svg)](https://github.com/marketplace/actions/github-commit-push-file) [![pipeline](https://img.shields.io/github/actions/workflow/status/maxgfr/github-commit-push-file/test-build.yml)](https://github.com/maxgfr/github-commit-push-file/actions/workflows/test-build.yml)

`maxgfr/github-commit-push-file` is a [GitHub Action](https://github.com/features/actions) which lets you commit and push files to a repository with advanced options like commit signing, custom author, and selective file staging.

## Features

- ✅ Commit and push files to a repository
- ✅ GPG commit signing support with enhanced validation
- ✅ Custom author name and email
- ✅ Selective file staging (specific files or all, with quote support for filenames with spaces)
- ✅ Target branch configuration
- ✅ Skip if no changes option
- ✅ Force push option
- ✅ Outputs for commit status and SHA
- ✅ Working directory support for monorepos

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

````yaml
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

        Note: If no changes are detected, the action will skip the commit and push and set the `committed` output to `false`.

### With Working Directory

This is useful for monorepos or when you want to commit files in a specific subdirectory:

```yaml
name: 'commit-in-subdirectory'
on:
  push:
    branches: [main]

jobs:
  action:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create a file in subdirectory
        run: echo "Content" >> packages/my-package/file.txt

      - name: Commit and push in subdirectory
        uses: maxgfr/github-commit-push-file@main
        with:
          commit_message: 'chore: update package file'
          work_dir: 'packages/my-package'
````

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

| Name                 | Type    | Required | Default                                 | Description                                                                               |
| -------------------- | ------- | -------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `commit_message`     | string  | **yes**  | -                                       | The commit message                                                                        |
| `files`              | string  | no       | `-A`                                    | Files to add (space-separated). Use `-A` for all files. Supports quoted paths with spaces |
| `branch`             | string  | no       | current branch                          | Target branch to push to                                                                  |
| `author_name`        | string  | no       | `GITHUB_ACTOR`                          | The name of the commit author                                                             |
| `author_email`       | string  | no       | `GITHUB_ACTOR@users.noreply.github.com` | The email of the commit author                                                            |
| `sign_commit`        | boolean | no       | `false`                                 | Whether to sign the commit with GPG                                                       |
| `gpg_private_key`    | string  | no       | -                                       | GPG private key (base64 encoded) for signing commits                                      |
| `gpg_passphrase`     | string  | no       | -                                       | Passphrase for the GPG private key                                                        |
| `force_push`         | boolean | no       | `true`                                  | Whether to force push                                                                     |
| `skip_if_no_changes` | boolean | no       | `true`                                  | Skip commit and push if there are no changes                                              |
| `work_dir`           | string  | no       | repository root                         | Working directory to execute git commands in                                              |

### Deprecated Inputs

| Name          | Type   | Description                                  |
| ------------- | ------ | -------------------------------------------- |
| `commit_name` | string | **Deprecated**: Use `commit_message` instead |

## Outputs

| Name         | Type   | Description                                         |
| ------------ | ------ | --------------------------------------------------- |
| `committed`  | string | Whether a commit was made (`true` or `false`)       |
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
- New features: `files`, `branch`, `author_name`, `author_email`, `sign_commit`, `gpg_private_key`, `gpg_passphrase`, `force_push`, `skip_if_no_changes`, `work_dir`
- New outputs: `committed`, `commit_sha`
- Enhanced GPG key validation
- Improved error handling

## Internal Functions Documentation

The action includes several utility functions for enhanced reliability:

### `isValidBase64(str: string): boolean`

**Purpose**: Validates if a string is properly base64 encoded.

**Parameters**:

- `str` - String to validate

**Returns**: `true` if valid base64, `false` otherwise

**Effects**: None (pure function)

**Used by**: `setupGpg()` for validating GPG keys

---

### `safeUnlinkSync(filePath: string): void`

**Purpose**: Safely removes a file if it exists, without throwing errors.

**Parameters**:

- `filePath` - Path to the file to remove

**Returns**: None

**Effects**: Removes the file at `filePath` if it exists

**Used by**: `setupGpg()` for cleanup in finally block

---

### `safeRmdirSync(dirPath: string): void`

**Purpose**: Safely removes a directory if it exists and is empty, without throwing errors.

**Parameters**:

- `dirPath` - Path to the directory to remove

**Returns**: None

**Effects**: Removes the directory at `dirPath` if it exists

**Used by**: `setupGpg()` for cleanup in finally block

---

### `safeMkdirSync(dirPath: string, mode: number): void`

**Purpose**: Safely creates a directory with proper permissions if it doesn't exist.

**Parameters**:

- `dirPath` - Path to the directory to create
- `mode` - File permissions mode (e.g., `0o700` for private directory)

**Returns**: None

**Effects**: Creates the directory at `dirPath` with specified permissions if it doesn't exist

**Used by**: `setupGpg()` for creating `.gnupg` directory

---

### `getInputs(): ActionInputs`

**Purpose**: Gets and validates action inputs from environment variables.

**Parameters**: None

**Returns**: `ActionInputs` object containing all configuration

**Effects**:

- Validates `commit_message` is provided (throws error if missing)
- Trims whitespace from commit message
- Logs warning for deprecated `commit_name` input

**Throws**: Error if `commit_message` is missing

---

### `setupGpg(gpgPrivateKey: string, gpgPassphrase: string): Promise<string>`

**Purpose**: Sets up GPG signing for git commits.

**Parameters**:

- `gpgPrivateKey` - Base64 encoded GPG private key
- `gpgPassphrase` - Optional passphrase for the GPG key

**Returns**: The GPG key ID

**Effects**:

- Validates base64 encoding of the key
- Validates decoded key is a valid PGP key
- Imports the key into GPG
- Configures git to use the key for signing
- Creates temporary files that are cleaned up in finally block

**Throws**: Error if:

- GPG key is not valid base64
- Decoded key is not a valid PGP key
- Key ID cannot be extracted
- GPG commands fail

**Side Effects**:

- Creates and removes temporary files
- Modifies git configuration
- May modify `.gnupg` directory in user home

---

### `hasChanges(files: string): Promise<boolean>`

**Purpose**: Adds files to git staging area and checks for changes.

**Parameters**:

- `files` - Files pattern ('-A' for all files, or space-separated list with quote support)

**Returns**: `true` if there are staged changes, `false` otherwise

**Effects**:

- Adds specified files to git staging area
- Runs `git diff --cached --quiet` to detect changes

**Side Effects**:

- Modifies git index (staging area)

---

### `run(): Promise<void>`

**Purpose**: Main execution function for the GitHub Action.

**Parameters**: None

**Returns**: Promise that resolves when complete

**Effects**:

- Gets and validates inputs
- Changes to working directory if specified
- Configures git user
- Sets up GPG signing if enabled
- Checks for changes
- Creates commit (or empty commit if no changes and `skip_if_no_changes=false`)
- Gets commit SHA
- Pushes to remote
- Sets action outputs

**Throws**: Error for various failure conditions, all caught and reported via `core.setFailed()`

**Side Effects**:

- May change current working directory
- Modifies git configuration
- Creates git commits
- Pushes to remote repository

## License

MIT
