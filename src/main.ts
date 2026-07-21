import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

interface CommitConfig {
  message: string
  body?: string
  files: string
}

interface ActionInputs {
  commitMessage: string
  commitBody: string
  files: string
  branch: string
  authorName: string
  authorEmail: string
  signCommit: boolean
  gpgPrivateKey: string
  gpgPassphrase: string
  forcePush: boolean
  skipIfNoChanges: boolean
  skipHooks: boolean
  workDir?: string
  dryRun: boolean
  tag: string
  tagMessage: string
  createBranch: boolean
  createPr: boolean
  prTitle: string
  prBaseBranch: string
  prBody: string
  prLabels: string[]
  prDraft: boolean
  token: string
  commits: CommitConfig[]
  amend: boolean
  retryOnConflict: boolean
  maxRetries: number
  excludeFiles: string
  pathspecFromFile: string
  commitTimestamp: string
}

interface CommitResult {
  committed: boolean
  sha: string
  changedFiles: string[]
}

interface PerformCommitOptions {
  message: string
  body: string
  files: string
  signCommit: boolean
  skipHooks: boolean
  skipIfNoChanges: boolean
  dryRun: boolean
  amend: boolean
  excludeFiles: string
  pathspecFromFile: string
  commitTimestamp: string
}

/**
 * Validates if a string is valid base64 encoded content.
 * Strips whitespace before validation to support keys with line breaks.
 */
const isValidBase64 = (str: string): boolean => {
  if (!str || str.length === 0) return false
  try {
    const cleaned = str.replace(/\s/g, '')
    return Buffer.from(cleaned, 'base64').toString('base64') === cleaned
  } catch {
    return false
  }
}

const safeUnlinkSync = (filePath: string): void => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // Ignore errors during cleanup
  }
}

const safeRmdirSync = (dirPath: string): void => {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmdirSync(dirPath)
    }
  } catch {
    // Ignore errors during cleanup
  }
}

const safeMkdirSync = (dirPath: string, mode: number): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, {mode, recursive: true})
  }
}

/**
 * Parses a space-separated file list with proper quote handling.
 * Tracks which character opened a quote so that e.g. an apostrophe
 * inside double quotes does not close the group.
 */
const parseFileList = (files: string): string[] => {
  const fileList: string[] = []
  let current = ''
  let quoteChar: string | null = null

  for (let i = 0; i < files.length; i++) {
    const char = files[i]
    if ((char === '"' || char === "'") && quoteChar === null) {
      quoteChar = char
    } else if (char === quoteChar) {
      quoteChar = null
    } else if (char === ' ' && quoteChar === null) {
      if (current.length > 0) {
        fileList.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current.length > 0) {
    fileList.push(current)
  }

  return fileList
}

/**
 * Expands template variables in a string.
 * Supported: {{date}}, {{datetime}}, {{sha}}, {{sha:short}},
 * {{branch}}, {{run_id}}, {{run_number}}, {{actor}}, {{repository}}
 */
const expandTemplateVars = (
  template: string,
  vars: Record<string, string>
): string => {
  if (!template.includes('{{')) return template
  return template.replace(
    /\{\{(\w+(?::\w+)?)\}\}/g,
    (_match, key: string) => vars[key] ?? _match
  )
}

/**
 * Builds the template variables map from the current environment.
 */
const buildTemplateVars = (
  targetBranch: string,
  headSha: string
): Record<string, string> => {
  const now = new Date()
  return {
    date: now.toISOString().split('T')[0],
    datetime: now.toISOString(),
    sha: headSha,
    'sha:short': headSha.substring(0, 7),
    branch: targetBranch,
    run_id: process.env.GITHUB_RUN_ID || '',
    run_number: process.env.GITHUB_RUN_NUMBER || '',
    actor: process.env.GITHUB_ACTOR || '',
    repository: process.env.GITHUB_REPOSITORY || ''
  }
}

/**
 * Reads the current HEAD SHA. Returns an empty string when the repository
 * has no commits yet (e.g. a freshly initialized repo or an orphan branch).
 */
const getHeadSha = async (): Promise<string> => {
  let output = ''
  const exitCode = await exec.exec('git', ['rev-parse', 'HEAD'], {
    ignoreReturnCode: true,
    silent: true,
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString()
      }
    }
  })
  return exitCode === 0 ? output.trim() : ''
}

const getInputs = (): ActionInputs => {
  let commitMessage = core.getInput('commit_message')
  if (!commitMessage) {
    commitMessage = core.getInput('commit_name')
    if (commitMessage) {
      core.warning(
        'The "commit_name" input is deprecated. Please use "commit_message" instead.'
      )
    }
  }

  const commitsJson = core.getInput('commits')
  let commits: CommitConfig[] = []
  if (commitsJson) {
    try {
      const parsed: unknown = JSON.parse(commitsJson)
      if (!Array.isArray(parsed)) {
        throw new Error('commits must be a JSON array')
      }
      commits = parsed as CommitConfig[]
      if (commits.length === 0) {
        throw new Error('commits array must not be empty')
      }
      for (const c of commits) {
        if (!c.message) {
          throw new Error(
            'Each commit in the commits array must have a "message" field'
          )
        }
        if (!c.files) {
          throw new Error(
            'Each commit in the commits array must have a "files" field. ' +
              'Without it, staging would pick up files intended for other commits in the array.'
          )
        }
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`Invalid JSON in commits input: ${e.message}`)
      }
      throw e
    }
  }

  if (!commitMessage && commits.length === 0) {
    throw new Error(
      'commit_message is required (or provide a non-empty commits JSON array).'
    )
  }

  if (commitMessage) {
    commitMessage = commitMessage.trim()
  }

  const amend = core.getInput('amend') === 'true'
  if (amend && commits.length > 0) {
    throw new Error('amend cannot be used with the commits array')
  }

  const maxRetriesInput = parseInt(core.getInput('max_retries') || '3', 10)

  const prLabelsRaw = core.getInput('pr_labels')
  const prLabels = prLabelsRaw
    ? prLabelsRaw
        .split(',')
        .map(l => l.trim())
        .filter(l => l.length > 0)
    : []

  const authorName =
    core.getInput('author_name') || process.env.GITHUB_ACTOR || 'github-actions'
  const authorEmail =
    core.getInput('author_email') ||
    `${process.env.GITHUB_ACTOR || 'github-actions'}@users.noreply.github.com`

  return {
    commitMessage,
    commitBody: core.getInput('commit_body'),
    files: core.getInput('files') || '-A',
    branch: core.getInput('branch'),
    authorName,
    authorEmail,
    signCommit: core.getInput('sign_commit') === 'true',
    gpgPrivateKey: core.getInput('gpg_private_key'),
    gpgPassphrase: core.getInput('gpg_passphrase'),
    forcePush: core.getInput('force_push') === 'true',
    skipIfNoChanges: core.getInput('skip_if_no_changes') === 'true',
    skipHooks: core.getInput('skip_hooks') !== 'false',
    workDir: core.getInput('work_dir') || undefined,
    dryRun: core.getInput('dry_run') === 'true',
    tag: core.getInput('tag'),
    tagMessage: core.getInput('tag_message'),
    createBranch: core.getInput('create_branch') === 'true',
    createPr: core.getInput('create_pr') === 'true',
    prTitle: core.getInput('pr_title'),
    prBaseBranch: core.getInput('pr_base_branch'),
    prBody: core.getInput('pr_body'),
    prLabels,
    prDraft: core.getInput('pr_draft') === 'true',
    token: core.getInput('token'),
    commits,
    amend,
    retryOnConflict: core.getInput('retry_on_conflict') === 'true',
    maxRetries: Math.max(1, isNaN(maxRetriesInput) ? 3 : maxRetriesInput),
    excludeFiles: core.getInput('exclude_files'),
    pathspecFromFile: core.getInput('pathspec_from_file'),
    commitTimestamp: core.getInput('commit_timestamp')
  }
}

const setupGpg = async (
  gpgPrivateKey: string,
  gpgPassphrase: string
): Promise<string> => {
  core.info('Setting up GPG for commit signing...')

  const cleanedKey = gpgPrivateKey.replace(/\s/g, '')

  if (!isValidBase64(cleanedKey)) {
    throw new Error('GPG private key must be valid base64 encoded string')
  }

  let gpgKey: string
  try {
    gpgKey = Buffer.from(cleanedKey, 'base64').toString('utf-8')
  } catch (error) {
    throw new Error(
      `Failed to decode GPG key: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }

  if (!gpgKey.trim().startsWith('-----BEGIN PGP')) {
    throw new Error('Decoded GPG key does not appear to be a valid PGP key')
  }

  let tmpDir: string | null = null
  let keyFile: string | null = null

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-'))
    keyFile = path.join(tmpDir, 'private.key')
    fs.writeFileSync(keyFile, gpgKey, {mode: 0o600})

    const importArgs = ['--batch', '--yes', '--import', keyFile]
    if (gpgPassphrase) {
      importArgs.splice(
        2,
        0,
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        gpgPassphrase
      )
    }
    await exec.exec('gpg', importArgs)

    let gpgOutput = ''
    await exec.exec(
      'gpg',
      ['--list-secret-keys', '--keyid-format', 'long', '--with-colons'],
      {
        listeners: {
          stdout: (data: Buffer) => {
            gpgOutput += data.toString()
          }
        }
      }
    )

    const match = gpgOutput.match(/sec:[^:]*:[^:]*:[^:]*:([A-F0-9]+):/i)
    const keyId = match ? match[1] : ''

    if (!keyId) {
      throw new Error('Failed to extract GPG key ID from imported key')
    }

    core.info(`GPG key imported with ID: ${keyId}`)

    await exec.exec('git', ['config', '--local', 'user.signingkey', keyId])
    await exec.exec('git', ['config', '--local', 'commit.gpgsign', 'true'])

    if (gpgPassphrase) {
      const gpgConfDir = path.join(os.homedir(), '.gnupg')
      safeMkdirSync(gpgConfDir, 0o700)

      const agentConfPath = path.join(gpgConfDir, 'gpg-agent.conf')
      const gpgConfPath = path.join(gpgConfDir, 'gpg.conf')

      fs.writeFileSync(agentConfPath, 'allow-loopback-pinentry\n', {
        mode: 0o600
      })
      fs.writeFileSync(gpgConfPath, 'use-agent\npinentry-mode loopback\n', {
        mode: 0o600
      })

      try {
        await exec.exec('gpgconf', ['--kill', 'gpg-agent'])
      } catch {
        // Ignore errors if gpg-agent is not running
      }
    }

    return keyId
  } finally {
    if (keyFile) {
      safeUnlinkSync(keyFile)
    }
    if (tmpDir) {
      safeRmdirSync(tmpDir)
    }
  }
}

const hasChanges = async (
  files: string,
  excludeFiles?: string,
  pathspecFromFile?: string
): Promise<boolean> => {
  // Stage files
  if (pathspecFromFile) {
    await exec.exec('git', ['add', '--pathspec-from-file', pathspecFromFile])
  } else if (files === '-A') {
    await exec.exec('git', ['add', '-A'])
  } else {
    const fileList = parseFileList(files)
    for (const file of fileList) {
      if (file.length > 0) {
        await exec.exec('git', ['add', file])
      }
    }
  }

  // Unstage excluded patterns
  if (excludeFiles) {
    const patterns = parseFileList(excludeFiles)
    for (const pattern of patterns) {
      if (pattern.length > 0) {
        await exec.exec('git', ['reset', 'HEAD', '--', pattern], {
          ignoreReturnCode: true
        })
      }
    }
  }

  const exitCode = await exec.exec('git', ['diff', '--cached', '--quiet'], {
    ignoreReturnCode: true
  })

  return exitCode !== 0
}

/**
 * Resolves the target branch from inputs and environment variables.
 * Properly handles refs/heads/, refs/tags/, and unknown ref formats.
 */
const resolveBranch = (inputBranch: string): string => {
  if (inputBranch) return inputBranch

  if (process.env.GITHUB_HEAD_REF) {
    return process.env.GITHUB_HEAD_REF
  }

  const githubRef = process.env.GITHUB_REF || ''
  if (githubRef.startsWith('refs/heads/')) {
    return githubRef.replace('refs/heads/', '')
  }
  if (githubRef.startsWith('refs/tags/')) {
    return githubRef.replace('refs/tags/', '')
  }

  // Unknown ref format (e.g. refs/pull/123/merge) falls back to main
  return 'main'
}

const performCommit = async (
  options: PerformCommitOptions
): Promise<CommitResult> => {
  const {
    message,
    body,
    files,
    signCommit,
    skipHooks,
    skipIfNoChanges,
    dryRun,
    amend,
    excludeFiles,
    pathspecFromFile,
    commitTimestamp
  } = options

  const changes = await hasChanges(files, excludeFiles, pathspecFromFile)

  if (!changes && !amend) {
    if (skipIfNoChanges) {
      core.info('No changes detected. Skipping commit.')
      return {committed: false, sha: '', changedFiles: []}
    } else {
      core.warning('No changes detected, but proceeding anyway.')
    }
  }

  // Capture list of changed files before commit
  let changedFilesOutput = ''
  await exec.exec('git', ['diff', '--cached', '--name-only'], {
    listeners: {
      stdout: (data: Buffer) => {
        changedFilesOutput += data.toString()
      }
    }
  })
  const changedFiles = changedFilesOutput
    .trim()
    .split('\n')
    .filter(f => f.length > 0)

  if (dryRun) {
    let stagedFiles = ''
    await exec.exec('git', ['diff', '--cached', '--name-status'], {
      listeners: {
        stdout: (data: Buffer) => {
          stagedFiles += data.toString()
        }
      }
    })
    core.info(`[DRY RUN] Would commit with message: "${message}"`)
    if (stagedFiles) {
      core.info(`[DRY RUN] Staged files:\n${stagedFiles.trim()}`)
    } else {
      core.info('[DRY RUN] No files staged (would be an empty commit)')
    }
    await exec.exec('git', ['reset'], {ignoreReturnCode: true})
    return {committed: false, sha: '', changedFiles: []}
  }

  let fullMessage = message
  if (body) {
    fullMessage += '\n\n' + body
  }

  const commitArgs = amend
    ? ['commit', '--amend', '-m', fullMessage]
    : ['commit', '-m', fullMessage]
  if (skipHooks) {
    commitArgs.push('--no-verify')
  }
  if (signCommit) {
    commitArgs.push('-S')
  }
  if (!changes && !amend) {
    commitArgs.push('--allow-empty')
  }

  // Set commit timestamp if provided, with try/finally for cleanup
  if (commitTimestamp) {
    process.env.GIT_AUTHOR_DATE = commitTimestamp
    process.env.GIT_COMMITTER_DATE = commitTimestamp
  }
  try {
    await exec.exec('git', commitArgs)
  } finally {
    if (commitTimestamp) {
      delete process.env.GIT_AUTHOR_DATE
      delete process.env.GIT_COMMITTER_DATE
    }
  }

  const commitSha = await getHeadSha()

  if (!commitSha) {
    throw new Error('Failed to get commit SHA after commit')
  }

  if (amend && changedFiles.length === 0) {
    let amendedFilesOutput = ''
    await exec.exec('git', ['show', '--name-only', '--format=', 'HEAD'], {
      listeners: {
        stdout: (data: Buffer) => {
          amendedFilesOutput += data.toString()
        }
      }
    })
    changedFiles.push(
      ...amendedFilesOutput
        .trim()
        .split('\n')
        .filter(f => f.length > 0)
    )
  }

  return {committed: true, sha: commitSha, changedFiles}
}

const createPullRequest = async (
  token: string,
  title: string,
  body: string,
  head: string,
  base: string,
  draft: boolean,
  labels: string[]
): Promise<{url: string; number: number}> => {
  const repository = process.env.GITHUB_REPOSITORY || ''
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com'

  let prBase = base
  if (!prBase) {
    const repoResponse = await fetch(`${apiUrl}/repos/${repository}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'github-commit-push-file'
      }
    })
    if (!repoResponse.ok) {
      throw new Error(
        `Failed to get repository info: ${repoResponse.statusText}`
      )
    }
    const repoData = (await repoResponse.json()) as {
      default_branch: string
    }
    prBase = repoData.default_branch
  }

  if (head === prBase) {
    throw new Error(
      `Cannot create a pull request: head branch "${head}" is the same as base branch "${prBase}". ` +
        'Use the "branch" input to push to a different branch than the base.'
    )
  }

  const prPayload: Record<string, unknown> = {
    title,
    head,
    base: prBase,
    body: body || ''
  }
  if (draft) {
    prPayload.draft = true
  }

  const response = await fetch(`${apiUrl}/repos/${repository}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'github-commit-push-file'
    },
    body: JSON.stringify(prPayload)
  })

  if (!response.ok) {
    const errorData = await response.text()
    throw new Error(`Failed to create PR: ${errorData}`)
  }

  const prData = (await response.json()) as {
    html_url: string
    number: number
  }

  // Add labels if provided (PRs use the Issues API for labels)
  if (labels.length > 0) {
    const labelResponse = await fetch(
      `${apiUrl}/repos/${repository}/issues/${prData.number}/labels`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'github-commit-push-file'
        },
        body: JSON.stringify({labels})
      }
    )
    if (!labelResponse.ok) {
      core.warning(
        `Failed to add labels to PR #${prData.number}: ${labelResponse.statusText}`
      )
    }
  }

  return {url: prData.html_url, number: prData.number}
}

const run = async (): Promise<void> => {
  try {
    const inputs = getInputs()

    core.info(`Author: ${inputs.authorName} <${inputs.authorEmail}>`)

    if (inputs.workDir) {
      core.info(`Changing working directory to: ${inputs.workDir}`)
      if (!fs.existsSync(inputs.workDir)) {
        throw new Error(`Working directory does not exist: ${inputs.workDir}`)
      }
      process.chdir(inputs.workDir)
    }

    // Configure git user with --local to avoid polluting shared runners
    await exec.exec('git', [
      'config',
      '--local',
      'user.name',
      inputs.authorName
    ])
    await exec.exec('git', [
      'config',
      '--local',
      'user.email',
      inputs.authorEmail
    ])

    // Configure token-based authentication if provided
    if (inputs.token) {
      core.setSecret(inputs.token)
      const repository = process.env.GITHUB_REPOSITORY || ''
      const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
      const host = new URL(serverUrl).host
      await exec.exec(
        'git',
        [
          'remote',
          'set-url',
          'origin',
          `https://x-access-token:${inputs.token}@${host}/${repository}.git`
        ],
        {silent: true}
      )
    }

    // Setup GPG signing if enabled
    if (inputs.signCommit) {
      if (!inputs.gpgPrivateKey) {
        throw new Error(
          'GPG private key is required when sign_commit is enabled'
        )
      }
      await setupGpg(inputs.gpgPrivateKey, inputs.gpgPassphrase)
      core.info('GPG signing enabled')
    }

    const targetBranch = resolveBranch(inputs.branch)

    // Build commit options shared across single/multi mode
    const baseCommitOpts = {
      signCommit: inputs.signCommit,
      skipHooks: inputs.skipHooks,
      skipIfNoChanges: inputs.skipIfNoChanges,
      dryRun: inputs.dryRun,
      amend: inputs.amend,
      excludeFiles: inputs.excludeFiles,
      pathspecFromFile: inputs.pathspecFromFile,
      commitTimestamp: inputs.commitTimestamp
    }

    // Perform commits
    let lastResult: CommitResult = {committed: false, sha: '', changedFiles: []}
    const allShas: string[] = []
    const allChangedFiles: string[] = []

    if (inputs.commits.length > 0) {
      core.info(`Processing ${inputs.commits.length} commits...`)
      for (let i = 0; i < inputs.commits.length; i++) {
        const commit = inputs.commits[i]
        core.info(`Commit ${i + 1}/${inputs.commits.length}: ${commit.message}`)
        // HEAD at this point is the parent of the commit being created
        const templateVars = buildTemplateVars(targetBranch, await getHeadSha())
        const result = await performCommit({
          ...baseCommitOpts,
          message: expandTemplateVars(commit.message, templateVars),
          body: expandTemplateVars(commit.body || '', templateVars),
          files: commit.files
        })
        if (result.committed) {
          allShas.push(result.sha)
          allChangedFiles.push(...result.changedFiles)
          lastResult = result
        }
      }
    } else {
      core.info(`Commit message: ${inputs.commitMessage}`)
      core.info(`Files to add: ${inputs.files}`)
      const templateVars = buildTemplateVars(targetBranch, await getHeadSha())
      lastResult = await performCommit({
        ...baseCommitOpts,
        message: expandTemplateVars(inputs.commitMessage, templateVars),
        body: expandTemplateVars(inputs.commitBody, templateVars),
        files: inputs.files
      })
      if (lastResult.committed) {
        allShas.push(lastResult.sha)
        allChangedFiles.push(...lastResult.changedFiles)
      }
    }

    const uniqueChangedFiles = [...new Set(allChangedFiles)]

    // Dry run: skip push, tag, PR
    if (inputs.dryRun) {
      core.info('[DRY RUN] Skipping push, tag, and PR creation.')
      core.setOutput('committed', 'false')
      core.setOutput('commit_sha', '')
      core.setOutput('commit_shas', '[]')
      core.setOutput('commit_url', '')
      core.setOutput('changed_files', '[]')
      return
    }

    // Nothing committed: skip push, tag, PR
    if (allShas.length === 0) {
      core.info('No commits were made.')
      core.setOutput('committed', 'false')
      core.setOutput('commit_sha', '')
      core.setOutput('commit_shas', '[]')
      core.setOutput('commit_url', '')
      core.setOutput('changed_files', '[]')
      return
    }

    // Push (with optional retry on conflict)
    core.info(`Pushing to branch: ${targetBranch}`)
    const pushArgs = ['push']
    if (inputs.forcePush) {
      pushArgs.push('-f')
    }
    if (inputs.createBranch) {
      // Strip existing refs/heads/ prefix to avoid double-prefixing
      const cleanBranch = targetBranch.startsWith('refs/heads/')
        ? targetBranch.replace('refs/heads/', '')
        : targetBranch
      pushArgs.push('-u', 'origin', `HEAD:refs/heads/${cleanBranch}`)
    } else {
      pushArgs.push('-u', 'origin', `HEAD:${targetBranch}`)
    }

    if (inputs.retryOnConflict && !inputs.forcePush) {
      // max_retries counts retries after the initial attempt
      const maxAttempts = inputs.maxRetries + 1
      let pushSuccess = false
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const exitCode = await exec.exec('git', pushArgs, {
          ignoreReturnCode: true
        })
        if (exitCode === 0) {
          pushSuccess = true
          break
        }
        if (attempt < maxAttempts) {
          core.warning(
            `Push failed (attempt ${attempt}/${maxAttempts}), pulling with rebase and retrying...`
          )
          const rebaseExit = await exec.exec(
            'git',
            ['pull', '--rebase', 'origin', targetBranch],
            {ignoreReturnCode: true}
          )
          if (rebaseExit !== 0) {
            await exec.exec('git', ['rebase', '--abort'], {
              ignoreReturnCode: true
            })
            throw new Error(
              'Push failed: rebase conflict encountered during retry. Manual intervention required.'
            )
          }
        }
      }
      if (!pushSuccess) {
        throw new Error(`Push failed after ${maxAttempts} attempts`)
      }
    } else {
      await exec.exec('git', pushArgs)
    }

    // Tag
    if (inputs.tag) {
      core.info(`Creating tag: ${inputs.tag}`)
      const tagArgs = ['tag']
      if (inputs.tagMessage) {
        tagArgs.push('-a', inputs.tag, '-m', inputs.tagMessage)
      } else {
        tagArgs.push(inputs.tag)
      }
      await exec.exec('git', tagArgs)
      await exec.exec('git', ['push', 'origin', inputs.tag])
      core.info(`Tag ${inputs.tag} pushed`)
    }

    // Set outputs
    const lastSha = allShas[allShas.length - 1]
    const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
    const repository = process.env.GITHUB_REPOSITORY || ''
    const commitUrl = repository
      ? `${serverUrl}/${repository}/commit/${lastSha}`
      : ''

    core.setOutput('committed', 'true')
    core.setOutput('commit_sha', lastSha)
    core.setOutput('commit_shas', JSON.stringify(allShas))
    core.setOutput('commit_url', commitUrl)
    core.setOutput('changed_files', JSON.stringify(uniqueChangedFiles))

    // Create PR if requested
    let prUrl = ''
    if (inputs.createPr) {
      if (!inputs.token) {
        throw new Error('token is required when create_pr is enabled')
      }
      // HEAD now points to the pushed commit
      const prTemplateVars = buildTemplateVars(targetBranch, await getHeadSha())
      const prTitle = expandTemplateVars(
        inputs.prTitle ||
          inputs.commitMessage ||
          inputs.commits[0]?.message ||
          'Automated changes',
        prTemplateVars
      )
      const prBody = expandTemplateVars(
        inputs.prBody || inputs.commitBody || '',
        prTemplateVars
      )
      core.info('Creating pull request...')
      const pr = await createPullRequest(
        inputs.token,
        prTitle,
        prBody,
        targetBranch,
        inputs.prBaseBranch,
        inputs.prDraft,
        inputs.prLabels
      )
      core.info(`Pull request created: ${pr.url}`)
      core.setOutput('pr_url', pr.url)
      core.setOutput('pr_number', String(pr.number))
      prUrl = pr.url
    }

    // Job summary
    try {
      core.summary.addHeading('Commit Summary')
      const rows: (string | {data: string; header: boolean})[][] = [
        [
          {data: 'Field', header: true},
          {data: 'Value', header: true}
        ],
        ['Branch', targetBranch],
        ['Commits', String(allShas.length)],
        ['Last SHA', `\`${lastSha}\``],
        ['Files Changed', String(uniqueChangedFiles.length)]
      ]
      if (commitUrl) {
        rows.push(['URL', commitUrl])
      }
      if (prUrl) {
        rows.push(['Pull Request', prUrl])
      }
      core.summary.addTable(rows)
      if (uniqueChangedFiles.length > 0) {
        core.summary.addHeading('Changed Files', 3)
        core.summary.addList(uniqueChangedFiles)
      }
      await core.summary.write()
    } catch {
      // Summary generation is non-critical
    }

    core.info('Successfully committed and pushed')
  } catch (e: unknown) {
    const error = e as Error
    core.setFailed(error.message)
  }
}

export {
  run,
  getInputs,
  setupGpg,
  hasChanges,
  parseFileList,
  isValidBase64,
  resolveBranch,
  getHeadSha,
  performCommit,
  createPullRequest,
  expandTemplateVars,
  buildTemplateVars
}

export type {CommitResult, PerformCommitOptions, CommitConfig, ActionInputs}

// Auto-execute when not running in Jest
if (!process.env.JEST_WORKER_ID) {
  void run()
}
