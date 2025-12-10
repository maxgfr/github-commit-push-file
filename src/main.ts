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
}

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
    skipIfNoChanges: core.getInput('skip_if_no_changes') === 'true'
  }
}

const setupGpg = async (
  gpgPrivateKey: string,
  gpgPassphrase: string
): Promise<string> => {
  core.info('Setting up GPG for commit signing...')

  // Decode base64 GPG key
  const gpgKey = Buffer.from(gpgPrivateKey, 'base64').toString('utf-8')

  // Create a temporary file for the GPG key
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-'))
  const keyFile = path.join(tmpDir, 'private.key')
  fs.writeFileSync(keyFile, gpgKey, {mode: 0o600})

  try {
    // Import the GPG key
    if (gpgPassphrase) {
      await exec.exec('gpg', [
        '--batch',
        '--yes',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        gpgPassphrase,
        '--import',
        keyFile
      ])
    } else {
      await exec.exec('gpg', ['--batch', '--yes', '--import', keyFile])
    }

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
      throw new Error('Failed to extract GPG key ID')
    }

    core.info(`GPG key imported with ID: ${keyId}`)

    // Configure git to use GPG
    await exec.exec('git', ['config', '--global', 'user.signingkey', keyId])
    await exec.exec('git', ['config', '--global', 'commit.gpgsign', 'true'])

    // Configure GPG to use loopback pinentry for passphrase
    if (gpgPassphrase) {
      const gpgConfDir = path.join(os.homedir(), '.gnupg')
      if (!fs.existsSync(gpgConfDir)) {
        fs.mkdirSync(gpgConfDir, {mode: 0o700})
      }
      fs.writeFileSync(
        path.join(gpgConfDir, 'gpg-agent.conf'),
        'allow-loopback-pinentry\n',
        {mode: 0o600}
      )
      fs.writeFileSync(
        path.join(gpgConfDir, 'gpg.conf'),
        'use-agent\npinentry-mode loopback\n',
        {mode: 0o600}
      )

      // Restart gpg-agent
      try {
        await exec.exec('gpgconf', ['--kill', 'gpg-agent'])
      } catch {
        // Ignore errors if gpg-agent is not running
      }
    }

    return keyId
  } finally {
    // Clean up the temporary key file
    fs.unlinkSync(keyFile)
    fs.rmdirSync(tmpDir)
  }
}

const hasChanges = async (files: string): Promise<boolean> => {
  // Add files first to check for changes
  if (files === '-A') {
    await exec.exec('git', ['add', '-A'])
  } else {
    const fileList = files.split(/\s+/).filter(f => f.length > 0)
    for (const file of fileList) {
      await exec.exec('git', ['add', file])
    }
  }

  // Check if there are staged changes
  const exitCode = await exec.exec('git', ['diff', '--cached', '--quiet'], {
    ignoreReturnCode: true
  })

  return exitCode !== 0
}

const run = async (): Promise<void> => {
  try {
    const inputs = getInputs()

    core.info(`Commit message: ${inputs.commitMessage}`)
    core.info(`Files to add: ${inputs.files}`)
    core.info(`Author: ${inputs.authorName} <${inputs.authorEmail}>`)

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
      core.info('No changes detected. Skipping commit and push.')
      core.setOutput('committed', 'false')
      core.setOutput('commit_sha', '')
      return
    }

    // Build commit command
    const commitArgs = ['commit', '-m', inputs.commitMessage, '--no-verify']

    if (inputs.signCommit) {
      commitArgs.push('-S')
    }

    // Only commit if there were staged changes (we already returned when no changes).

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

    // Determine target branch
    let targetBranch = inputs.branch
    if (!targetBranch) {
      targetBranch =
        process.env.GITHUB_HEAD_REF ||
        process.env.GITHUB_REF?.replace('refs/heads/', '') ||
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
  }
}

run()
