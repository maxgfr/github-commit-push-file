import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

interface ActionInputs {
  commitMessage: string
  files: string
  branch: string
  authorName: string
  authorEmail: string
  signCommit: boolean
  gpgPrivateKey: string
  gpgPassphrase: string
  forcePush: boolean
  skipIfNoChanges: boolean
  workDir?: string
}

/**
 * Validates if a string is valid base64 encoded content
 * @param str - String to validate
 * @returns true if valid base64, false otherwise
 */
const isValidBase64 = (str: string): boolean => {
  if (!str || str.length === 0) return false
  try {
    return Buffer.from(str, 'base64').toString('base64') === str
  } catch {
    return false
  }
}

/**
 * Safely removes a file if it exists
 * @param filePath - Path to the file to remove
 */
const safeUnlinkSync = (filePath: string): void => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Safely removes a directory if it exists and is empty
 * @param dirPath - Path to the directory to remove
 */
const safeRmdirSync = (dirPath: string): void => {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmdirSync(dirPath)
    }
  } catch {
    // Ignore errors during cleanup (directory may not be empty)
  }
}

/**
 * Safely creates a directory with proper permissions if it doesn't exist
 * @param dirPath - Path to the directory to create
 * @param mode - File permissions mode
 */
const safeMkdirSync = (dirPath: string, mode: number): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, {mode, recursive: true})
  }
}

/**
 * Gets and validates action inputs from environment
 * @returns ActionInputs object containing all configuration
 * @throws Error if required inputs are missing
 */
const getInputs = (): ActionInputs => {
  // Support both new 'commit_message' and deprecated 'commit_name'
  let commitMessage = core.getInput('commit_message')
  if (!commitMessage) {
    commitMessage = core.getInput('commit_name')
    if (commitMessage) {
      core.warning(
        'The "commit_name" input is deprecated. Please use "commit_message" instead.'
      )
    }
  }

  if (!commitMessage) {
    throw new Error(
      'commit_message is required. Please provide a commit message.'
    )
  }

  // Trim commit message to avoid issues with trailing whitespace
  commitMessage = commitMessage.trim()

  const authorName =
    core.getInput('author_name') || process.env.GITHUB_ACTOR || 'github-actions'
  const authorEmail =
    core.getInput('author_email') ||
    `${process.env.GITHUB_ACTOR || 'github-actions'}@users.noreply.github.com`

  return {
    commitMessage,
    files: core.getInput('files') || '-A',
    branch: core.getInput('branch'),
    authorName,
    authorEmail,
    signCommit: core.getInput('sign_commit') === 'true',
    gpgPrivateKey: core.getInput('gpg_private_key'),
    gpgPassphrase: core.getInput('gpg_passphrase'),
    forcePush: core.getInput('force_push') !== 'false',
    skipIfNoChanges: core.getInput('skip_if_no_changes') === 'true',
    workDir: core.getInput('work_dir') || undefined
  }
}

/**
 * Sets up GPG signing for git commits
 * @param gpgPrivateKey - Base64 encoded GPG private key
 * @param gpgPassphrase - Optional passphrase for the GPG key
 * @returns The GPG key ID
 * @throws Error if GPG setup fails
 */
const setupGpg = async (
  gpgPrivateKey: string,
  gpgPassphrase: string
): Promise<string> => {
  core.info('Setting up GPG for commit signing...')

  // Validate base64 encoding
  if (!isValidBase64(gpgPrivateKey)) {
    throw new Error('GPG private key must be valid base64 encoded string')
  }

  // Decode base64 GPG key
  let gpgKey: string
  try {
    gpgKey = Buffer.from(gpgPrivateKey, 'base64').toString('utf-8')
  } catch (error) {
    throw new Error(
      `Failed to decode GPG key: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }

  // Validate decoded key is not empty
  if (!gpgKey.trim().startsWith('-----BEGIN PGP')) {
    throw new Error('Decoded GPG key does not appear to be a valid PGP key')
  }

  // Create a temporary file for the GPG key
  let tmpDir: string | null = null
  let keyFile: string | null = null

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-'))
    keyFile = path.join(tmpDir, 'private.key')
    fs.writeFileSync(keyFile, gpgKey, {mode: 0o600})

    // Import the GPG key
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

    // Get the key ID
    let keyId = ''
    await exec.exec(
      'gpg',
      ['--list-secret-keys', '--keyid-format', 'long', '--with-colons'],
      {
        listeners: {
          stdout: (data: Buffer) => {
            const output = data.toString()
            const match = output.match(/sec:[^:]*:[^:]*:[^:]*:([A-F0-9]+):/i)
            if (match) {
              keyId = match[1]
            }
          }
        }
      }
    )

    if (!keyId) {
      throw new Error('Failed to extract GPG key ID from imported key')
    }

    core.info(`GPG key imported with ID: ${keyId}`)

    // Configure git to use GPG
    await exec.exec('git', ['config', '--global', 'user.signingkey', keyId])
    await exec.exec('git', ['config', '--global', 'commit.gpgsign', 'true'])

    // Configure GPG to use loopback pinentry for passphrase
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

      // Restart gpg-agent
      try {
        await exec.exec('gpgconf', ['--kill', 'gpg-agent'])
      } catch {
        // Ignore errors if gpg-agent is not running
      }
    }

    return keyId
  } finally {
    // Clean up the temporary key file and directory
    if (keyFile) {
      safeUnlinkSync(keyFile)
    }
    if (tmpDir) {
      safeRmdirSync(tmpDir)
    }
  }
}

/**
 * Adds files to git staging area and checks for changes
 * @param files - Files pattern ('-A' for all files, or space-separated list)
 * @returns true if there are staged changes, false otherwise
 */
const hasChanges = async (files: string): Promise<boolean> => {
  // Add files first to check for changes
  if (files === '-A') {
    await exec.exec('git', ['add', '-A'])
  } else {
    // Split by whitespace, but handle quoted paths
    const fileList: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < files.length; i++) {
      const char = files[i]
      if (char === '"' || char === "'") {
        inQuotes = !inQuotes
      } else if (char === ' ' && !inQuotes) {
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

    // Add each file individually
    for (const file of fileList) {
      if (file.length > 0) {
        await exec.exec('git', ['add', file])
      }
    }
  }

  // Check if there are staged changes
  const exitCode = await exec.exec('git', ['diff', '--cached', '--quiet'], {
    ignoreReturnCode: true
  })

  return exitCode !== 0
}

/**
 * Main execution function for the GitHub Action
 * Commits and pushes files to the repository
 */
const run = async (): Promise<void> => {
  try {
    const inputs = getInputs()

    core.info(`Commit message: ${inputs.commitMessage}`)
    core.info(`Files to add: ${inputs.files}`)
    core.info(`Author: ${inputs.authorName} <${inputs.authorEmail}>`)

    // Change to working directory if specified
    if (inputs.workDir) {
      core.info(`Changing working directory to: ${inputs.workDir}`)
      if (!fs.existsSync(inputs.workDir)) {
        throw new Error(`Working directory does not exist: ${inputs.workDir}`)
      }
      process.chdir(inputs.workDir)
    }

    // Configure git user
    await exec.exec('git', [
      'config',
      '--global',
      'user.name',
      inputs.authorName
    ])
    await exec.exec('git', [
      'config',
      '--global',
      'user.email',
      inputs.authorEmail
    ])

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

    // Check for changes if skip_if_no_changes is enabled
    const changes = await hasChanges(inputs.files)

    if (!changes) {
      if (inputs.skipIfNoChanges) {
        core.info('No changes detected. Skipping commit and push.')
        core.setOutput('committed', 'false')
        core.setOutput('commit_sha', '')
        return
      } else {
        core.warning('No changes detected, but proceeding anyway.')
      }
    }

    // Build commit command
    const commitArgs = ['commit', '-m', inputs.commitMessage, '--no-verify']

    if (inputs.signCommit) {
      commitArgs.push('-S')
    }

    // If there are no changes and the user explicitly set skip_if_no_changes=false,
    // allow an empty commit so the workflow can still produce a commit event.
    if (!changes) {
      commitArgs.push('--allow-empty')
    }

    await exec.exec('git', commitArgs)

    // Get the commit SHA
    let commitSha = ''
    await exec.exec('git', ['rev-parse', 'HEAD'], {
      listeners: {
        stdout: (data: Buffer) => {
          commitSha = data.toString().trim()
        }
      }
    })

    if (!commitSha) {
      throw new Error('Failed to get commit SHA after commit')
    }

    // Determine target branch
    let targetBranch = inputs.branch
    if (!targetBranch) {
      // GITHUB_HEAD_REF is set for pull request events
      // GITHUB_REF is set for all events and includes refs/heads/ for branch events
      targetBranch =
        process.env.GITHUB_HEAD_REF ||
        process.env.GITHUB_REF?.replace('refs/heads/', '') ||
        process.env.GITHUB_REF?.replace('refs/tags/', '') ||
        'main'
    }

    core.info(`Pushing to branch: ${targetBranch}`)

    // Build push command
    const pushArgs = ['push']
    if (inputs.forcePush) {
      pushArgs.push('-f')
    }
    pushArgs.push('-u', 'origin', `HEAD:${targetBranch}`)

    await exec.exec('git', pushArgs)

    core.info('File has been successfully committed and pushed')
    core.setOutput('committed', 'true')
    core.setOutput('commit_sha', commitSha)
  } catch (e: unknown) {
    const error = e as Error
    core.setFailed(error.message)
    throw error // Re-throw to ensure process exits with error
  }
}

// Execute the action with top-level error handling
run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : String(error)
  core.setFailed(`Action failed: ${errorMessage}`)
  process.exit(1)
})
