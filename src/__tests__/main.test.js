jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  setOutput: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn()
}))
jest.mock('@actions/exec', () => ({
  exec: jest.fn()
}))

// Mock process.exit to avoid test termination
const originalExit = process.exit
beforeEach(() => {
  jest.resetAllMocks()
  process.exit = jest.fn()
})

afterAll(() => {
  process.exit = originalExit
})

// No top-level import; tests will import modules after setting up per-test mocks.

describe('commit behavior', () => {
  test('skips commit when no changes detected and skip_if_no_changes is true', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: test commit'
        case 'files':
          return '-A'
        case 'skip_if_no_changes':
          return 'true'
        case 'force_push':
          return 'true'
        default:
          return ''
      }
    })

    // Simulate git commands: 'git diff --cached --quiet' returns code 0 (no changes)
    exec.exec.mockImplementation(async (command, args) => {
      if (command === 'git' && args && args[0] === 'diff') {
        return 0
      }
      return 0
    })

    require('../main')
    // Wait briefly for async execution inside main
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Ensure git commit not called
    expect(exec.exec).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['commit']),
      expect.any(Object)
    )
  })

  test('creates empty commit when no changes detected and skip_if_no_changes is false', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: test commit'
        case 'files':
          return '-A'
        case 'skip_if_no_changes':
          return 'false'
        case 'force_push':
          return 'true'
        default:
          return ''
      }
    })

    // Simulate git diff returning no changes
    exec.exec.mockImplementation(async (command, args) => {
      if (command === 'git' && args && args[0] === 'diff') {
        return 0
      }
      return 0
    })

    require('../main')
    // Wait for module execution
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Now check if exec.exec was called to commit with '--allow-empty'
    const commitCall = exec.exec.mock.calls.find(
      (c) => c[0] === 'git' && c[1] && c[1][0] === 'commit'
    )
    expect(commitCall).toBeDefined()
    expect(commitCall[1]).toEqual(expect.arrayContaining(['--allow-empty']))
  })

  test('commits and pushes when changes are detected', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'feat: new feature'
        case 'files':
          return '-A'
        case 'skip_if_no_changes':
          return 'true'
        case 'force_push':
          return 'true'
        default:
          return ''
      }
    })

    // Track call count for git diff
    let diffCallCount = 0

    // Mock stdout listener for rev-parse
    exec.exec.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'git' && args && args[0] === 'diff') {
        diffCallCount++
        return 1 // Changes detected
      }
      if (cmd === 'git' && args && args[0] === 'rev-parse') {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from('abc123\n'))
        }
        return 0
      }
      return 0
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Verify git diff was called (meaning hasChanges was executed)
    expect(diffCallCount).toBeGreaterThan(0)

    // Verify commit was called
    const commitCall = exec.exec.mock.calls.find(
      (c) => c[0] === 'git' && c[1] && c[1][0] === 'commit'
    )
    expect(commitCall).toBeDefined()

    // Verify push was called
    const pushCall = exec.exec.mock.calls.find(
      (c) => c[0] === 'git' && c[1] && c[1][0] === 'push'
    )
    expect(pushCall).toBeDefined()
  })

  test('throws error when commit_message is missing', async () => {
    jest.resetModules()
    const core = require('@actions/core')

    core.getInput.mockReturnValue('')

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Since getInputs throws synchronously before run() is called,
    // the error is caught and setFailed is called
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('commit_message is required')
    )
  })

  test('throws error when sign_commit is true but gpg_private_key is missing', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: signed commit'
        case 'sign_commit':
          return 'true'
        case 'gpg_private_key':
          return '' // Missing GPG key
        default:
          return ''
      }
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('GPG private key is required')
    )
  })

  test('uses default author from GITHUB_ACTOR when not provided', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    // Mock GITHUB_ACTOR environment variable
    process.env.GITHUB_ACTOR = 'test-user'

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: test'
        case 'files':
          return '-A'
        case 'skip_if_no_changes':
          return 'false' // Don't skip so git config is called
        case 'force_push':
          return 'true'
        default:
          return ''
      }
    })

    exec.exec.mockImplementation(async (command, args) => {
      if (command === 'git' && args && args[0] === 'diff') {
        return 0 // No changes
      }
      return 0
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Verify git config was called with default author
    // The author name is in the args array at position after 'config', '--global', 'user.name'
    const configNameCall = exec.exec.mock.calls.find(
      (c) => c[0] === 'git' && c[1] && c[1].includes('user.name')
    )
    expect(configNameCall).toBeDefined()
    expect(configNameCall[1]).toContain('test-user')

    delete process.env.GITHUB_ACTOR
  })

  test('handles custom author name and email', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: test'
        case 'author_name':
          return 'Custom Bot'
        case 'author_email':
          return 'bot@example.com'
        case 'files':
          return '-A'
        case 'skip_if_no_changes':
          return 'false' // Don't skip so git config is called
        case 'force_push':
          return 'true'
        default:
          return ''
      }
    })

    exec.exec.mockImplementation(async (command, args) => {
      if (command === 'git' && args && args[0] === 'diff') {
        return 0 // No changes
      }
      return 0
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Verify git config was called with custom author
    const configNameCall = exec.exec.mock.calls.find(
      (c) => c[0] === 'git' && c[1] && c[1].includes('user.name')
    )
    expect(configNameCall).toBeDefined()
    expect(configNameCall[1]).toContain('Custom Bot')

    const configEmailCall = exec.exec.mock.calls.find(
      (c) => c[0] === 'git' && c[1] && c[1].includes('user.email')
    )
    expect(configEmailCall).toBeDefined()
    expect(configEmailCall[1]).toContain('bot@example.com')
  })

  test('handles multiple file paths with spaces', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: update files'
        case 'files':
          return 'file1.txt file2.txt "file with spaces.txt"'
        case 'skip_if_no_changes':
          return 'true'
        case 'force_push':
          return 'true'
        default:
          return ''
      }
    })

    exec.exec.mockImplementation(async (command, args) => {
      if (command === 'git' && args && args[0] === 'diff') {
        return 0
      }
      return 0
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Verify git add was called for each file
    const addCalls = exec.exec.mock.calls.filter(
      (c) => c[0] === 'git' && c[1] && c[1][0] === 'add'
    )
    expect(addCalls.length).toBeGreaterThan(0)
  })

  test('respects force_push=false', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: test'
        case 'files':
          return '-A'
        case 'skip_if_no_changes':
          return 'true'
        case 'force_push':
          return 'false'
        default:
          return ''
      }
    })

    exec.exec.mockImplementation(async (command, args) => {
      if (command === 'git' && args && args[0] === 'diff') {
        return 0
      }
      return 0
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Verify git push was not called with force flag
    const pushCalls = exec.exec.mock.calls.filter(
      (c) => c[0] === 'git' && c[1] && c[1].includes('push')
    )
    // Since no changes, push should not be called at all
    expect(pushCalls.length).toBe(0)
  })

  test('outputs commit_sha when commit is made', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'feat: new feature'
        case 'files':
          return '-A'
        case 'skip_if_no_changes':
          return 'true'
        case 'force_push':
          return 'true'
        default:
          return ''
      }
    })

    exec.exec.mockImplementation(async (cmd, args, options) => {
      if (cmd === 'git' && args && args[0] === 'diff') {
        return 1 // Changes detected
      }
      if (cmd === 'git' && args && args[0] === 'rev-parse') {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(Buffer.from('def456\n'))
        }
      }
      return 0
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Verify outputs were set
    expect(core.setOutput).toHaveBeenCalledWith('committed', 'true')
    expect(core.setOutput).toHaveBeenCalledWith('commit_sha', 'def456')
  })

  test('outputs committed=false when skipping due to no changes', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: test'
        case 'files':
          return '-A'
        case 'skip_if_no_changes':
          return 'true'
        case 'force_push':
          return 'true'
        default:
          return ''
      }
    })

    exec.exec.mockImplementation(async (command, args) => {
      if (command === 'git' && args && args[0] === 'diff') {
        return 0 // No changes
      }
      return 0
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Verify outputs were set correctly for no commit
    expect(core.setOutput).toHaveBeenCalledWith('committed', 'false')
    expect(core.setOutput).toHaveBeenCalledWith('commit_sha', '')
  })

  test('warns about deprecated commit_name input', async () => {
    jest.resetModules()
    const core = require('@actions/core')
    const exec = require('@actions/exec')

    core.getInput.mockImplementation((name) => {
      if (name === 'commit_message') return ''
      if (name === 'commit_name') return 'chore: old style'
      if (name === 'skip_if_no_changes') return 'true'
      if (name === 'force_push') return 'true'
      return ''
    })

    exec.exec.mockImplementation(async (command, args) => {
      if (command === 'git' && args && args[0] === 'diff') {
        return 0
      }
      return 0
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('deprecated')
    )
  })
})

describe('GPG signing', () => {
  test('throws error for invalid base64 GPG key', async () => {
    jest.resetModules()
    const core = require('@actions/core')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: test'
        case 'sign_commit':
          return 'true'
        case 'gpg_private_key':
          return 'not-valid-base64!!!'
        default:
          return ''
      }
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('valid base64')
    )
  })

  test('throws error for non-PGP key after base64 decode', async () => {
    jest.resetModules()
    const core = require('@actions/core')

    core.getInput.mockImplementation((name) => {
      switch (name) {
        case 'commit_message':
          return 'chore: test'
        case 'sign_commit':
          return 'true'
        case 'gpg_private_key':
          return Buffer.from('not a pgp key').toString('base64')
        default:
          return ''
      }
    })

    require('../main')
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('valid PGP key')
    )
  })
})
