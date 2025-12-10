const core = require('@actions/core')
const exec = require('@actions/exec')

jest.mock('@actions/core')
jest.mock('@actions/exec')

// Reset mocks before each test
beforeEach(() => {
  jest.resetAllMocks()
})

// Import the module after setting up mocks
require('../main')

describe('commit behavior', () => {
  test('skips commit when no changes detected and skip_if_no_changes is true', async () => {
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

    // Wait briefly for async execution inside main
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Ensure git commit not called
    expect(exec.exec).not.toHaveBeenCalledWith('git', expect.arrayContaining(['commit']), expect.any(Object))
  })

  test('creates empty commit when no changes detected and skip_if_no_changes is false', async () => {
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

    // Wait for module execution
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Now check if exec.exec was called to commit with '--allow-empty'
    const commitCall = exec.exec.mock.calls.find((c) => c[0] === 'git' && c[1] && c[1][0] === 'commit')
    expect(commitCall).toBeDefined()
    expect(commitCall[1]).toEqual(expect.arrayContaining(['--allow-empty']))
  })
})
