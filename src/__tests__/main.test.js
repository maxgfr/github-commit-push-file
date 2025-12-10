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

// Reset mocks before each test
beforeEach(() => {
  jest.resetAllMocks()
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
    // Debugging: print calls
    
    const commitCall = exec.exec.mock.calls.find((c) => c[0] === 'git' && c[1] && c[1][0] === 'commit')
    expect(commitCall).toBeDefined()
    expect(commitCall[1]).toEqual(expect.arrayContaining(['--allow-empty']))
  })
})
