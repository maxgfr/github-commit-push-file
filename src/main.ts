import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

interface CommitConfig {
  message: string
  body?: string
  files?: string
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
  token: string
  commits: CommitConfig[]
}

interface CommitResult {
  committed: boolean
  sha: string
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
      for (const c of commits) {
        if (!c.message) {
          throw new Error(
            'Each commit in the commits array must have a "message" field'
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
      'commit_message is required (or provide a commits JSON array).'
    )
  }

  if (commitMessage) {
    commitMessage = commitMessage.trim()
  }

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
    token: core.getInput('token'),
    commits
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

const hasChanges = async (files: string): Promise<boolean> => {
  if (files === '-A') {
    await exec.exec('git', ['add', '-A'])
  } else {
    const fileList = parseFileList(files)
    for (const file of fileList) {
      if (file.length > 0) {
        await exec.exec('git', ['add', file])
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
 * Properly handles both refs/heads/ and refs/tags/ prefixes.
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

  return 'main'
}

const performCommit = async (
  message: string,
  body: string,
  files: string,
  signCommit: boolean,
  skipHooks: boolean,
  skipIfNoChanges: boolean,
  dryRun: boolean
): Promise<CommitResult> => {
  const changes = await hasChanges(files)

  if (!changes) {
    if (skipIfNoChanges) {
      core.info('No changes detected. Skipping commit.')
      return {committed: false, sha: ''}
    } else {
      core.warning('No changes detected, but proceeding anyway.')
    }
  }

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
    return {committed: false, sha: ''}
  }

  let fullMessage = message
  if (body) {
    fullMessage += '\n\n' + body
  }

  const commitArgs = ['commit', '-m', fullMessage]
  if (skipHooks) {
    commitArgs.push('--no-verify')
  }
  if (signCommit) {
    commitArgs.push('-S')
  }
  if (!changes) {
    commitArgs.push('--allow-empty')
  }

  await exec.exec('git', commitArgs)

  let commitSha = ''
  await exec.exec('git', ['rev-parse', 'HEAD'], {
    listeners: {
      stdout: (data: Buffer) => {
        commitSha += data.toString()
      }
    }
  })
  commitSha = commitSha.trim()

  if (!commitSha) {
    throw new Error('Failed to get commit SHA after commit')
  }

  return {committed: true, sha: commitSha}
}

const createPullRequest = async (
  token: string,
  title: string,
  body: string,
  head: string,
  base: string
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

  const response = await fetch(`${apiUrl}/repos/${repository}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'github-commit-push-file'
    },
    body: JSON.stringify({
      title,
      head,
      base: prBase,
      body: body || ''
    })
  })

  if (!response.ok) {
    const errorData = await response.text()
    throw new Error(`Failed to create PR: ${errorData}`)
  }

  const prData = (await response.json()) as {
    html_url: string
    number: number
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

    // Perform commits
    let lastResult: CommitResult = {committed: false, sha: ''}
    const allShas: string[] = []

    if (inputs.commits.length > 0) {
      core.info(`Processing ${inputs.commits.length} commits...`)
      for (let i = 0; i < inputs.commits.length; i++) {
        const commit = inputs.commits[i]
        core.info(`Commit ${i + 1}/${inputs.commits.length}: ${commit.message}`)
        const result = await performCommit(
          commit.message,
          commit.body || '',
          commit.files || inputs.files,
          inputs.signCommit,
          inputs.skipHooks,
          inputs.skipIfNoChanges,
          inputs.dryRun
        )
        if (result.committed) {
          allShas.push(result.sha)
          lastResult = result
        }
      }
    } else {
      core.info(`Commit message: ${inputs.commitMessage}`)
      core.info(`Files to add: ${inputs.files}`)
      lastResult = await performCommit(
        inputs.commitMessage,
        inputs.commitBody,
        inputs.files,
        inputs.signCommit,
        inputs.skipHooks,
        inputs.skipIfNoChanges,
        inputs.dryRun
      )
      if (lastResult.committed) {
        allShas.push(lastResult.sha)
      }
    }

    // Dry run: skip push, tag, PR
    if (inputs.dryRun) {
      core.info('[DRY RUN] Skipping push, tag, and PR creation.')
      core.setOutput('committed', 'false')
      core.setOutput('commit_sha', '')
      core.setOutput('commit_shas', '[]')
      core.setOutput('commit_url', '')
      return
    }

    // Nothing committed: skip push, tag, PR
    if (allShas.length === 0) {
      core.info('No commits were made.')
      core.setOutput('committed', 'false')
      core.setOutput('commit_sha', '')
      core.setOutput('commit_shas', '[]')
      core.setOutput('commit_url', '')
      return
    }

    // Push
    core.info(`Pushing to branch: ${targetBranch}`)
    const pushArgs = ['push']
    if (inputs.forcePush) {
      pushArgs.push('-f')
    }
    if (inputs.createBranch) {
      pushArgs.push('-u', 'origin', `HEAD:refs/heads/${targetBranch}`)
    } else {
      pushArgs.push('-u', 'origin', `HEAD:${targetBranch}`)
    }
    await exec.exec('git', pushArgs)

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

    // Create PR if requested
    if (inputs.createPr) {
      if (!inputs.token) {
        throw new Error('token is required when create_pr is enabled')
      }
      const prTitle =
        inputs.prTitle ||
        inputs.commitMessage ||
        inputs.commits[0]?.message ||
        'Automated changes'
      const prBody = inputs.prBody || inputs.commitBody || ''
      core.info('Creating pull request...')
      const pr = await createPullRequest(
        inputs.token,
        prTitle,
        prBody,
        targetBranch,
        inputs.prBaseBranch
      )
      core.info(`Pull request created: ${pr.url}`)
      core.setOutput('pr_url', pr.url)
      core.setOutput('pr_number', String(pr.number))
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
  performCommit,
  createPullRequest
}

// Auto-execute when not running in Jest
if (!process.env.JEST_WORKER_ID) {
  void run()
}
