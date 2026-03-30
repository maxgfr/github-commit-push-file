/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */

jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  setOutput: jest.fn(),
  setSecret: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn()
}))

jest.mock('@actions/exec', () => ({
  exec: jest.fn()
}))

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {
  run,
  parseFileList,
  isValidBase64,
  resolveBranch,
  getInputs
} from '../main'

const mockGetInput = core.getInput as jest.Mock
const mockSetOutput = core.setOutput as jest.Mock
const mockSetSecret = core.setSecret as jest.Mock
const mockInfo = core.info as jest.Mock
const mockWarning = core.warning as jest.Mock
const mockSetFailed = core.setFailed as jest.Mock
const mockExecFn = exec.exec as jest.Mock

const savedEnv = {...process.env}

// ==================== Helpers ====================

const mockInputs = (inputs: Record<string, string>): void => {
  mockGetInput.mockImplementation((name: string) => inputs[name] || '')
}

const mockExecDefault = (options?: {
  hasChanges?: boolean
  commitSha?: string
  stagedFiles?: string
}): void => {
  const {
    hasChanges: changes = false,
    commitSha = 'abc123def456',
    stagedFiles = ''
  } = options || {}

  mockExecFn.mockImplementation(
    async (cmd: string, args?: string[], opts?: any): Promise<number> => {
      if (cmd === 'git' && args?.[0] === 'diff') {
        if (args?.[1] === '--cached' && args?.[2] === '--quiet') {
          return changes ? 1 : 0
        }
        if (args?.[1] === '--cached' && args?.[2] === '--name-status') {
          if (opts?.listeners?.stdout && stagedFiles) {
            opts.listeners.stdout(Buffer.from(stagedFiles))
          }
          return 0
        }
      }
      if (cmd === 'git' && args?.[0] === 'rev-parse') {
        if (opts?.listeners?.stdout) {
          opts.listeners.stdout(Buffer.from(commitSha + '\n'))
        }
        return 0
      }
      return 0
    }
  )
}

// ==================== Setup ====================

beforeEach(() => {
  jest.resetAllMocks()
  process.env = {...savedEnv}
  delete process.env.GITHUB_ACTOR
  delete process.env.GITHUB_HEAD_REF
  delete process.env.GITHUB_REF
  delete process.env.GITHUB_REPOSITORY
  delete process.env.GITHUB_SERVER_URL
  delete process.env.GITHUB_API_URL
  global.fetch = jest.fn()
})

afterAll(() => {
  process.env = savedEnv
})

// ==================== Unit tests: parseFileList ====================

describe('parseFileList', () => {
  test('returns empty array for empty string', () => {
    expect(parseFileList('')).toEqual([])
  })

  test('parses single file', () => {
    expect(parseFileList('file.txt')).toEqual(['file.txt'])
  })

  test('parses multiple space-separated files', () => {
    expect(parseFileList('a.txt b.txt c.txt')).toEqual([
      'a.txt',
      'b.txt',
      'c.txt'
    ])
  })

  test('handles double-quoted paths with spaces', () => {
    expect(parseFileList('"file with spaces.txt"')).toEqual([
      'file with spaces.txt'
    ])
  })

  test('handles single-quoted paths with spaces', () => {
    expect(parseFileList("'file with spaces.txt'")).toEqual([
      'file with spaces.txt'
    ])
  })

  test('handles apostrophe inside double quotes', () => {
    expect(parseFileList('"file\'s name.txt"')).toEqual(["file's name.txt"])
  })

  test('handles mixed quoted and unquoted files', () => {
    expect(parseFileList('a.txt "b c.txt" d.txt')).toEqual([
      'a.txt',
      'b c.txt',
      'd.txt'
    ])
  })

  test('handles multiple spaces between files', () => {
    expect(parseFileList('a.txt   b.txt')).toEqual(['a.txt', 'b.txt'])
  })

  test('handles single quote inside double quotes', () => {
    expect(parseFileList('"it\'s a file.txt" other.txt')).toEqual([
      "it's a file.txt",
      'other.txt'
    ])
  })

  test('handles double quote inside single quotes', () => {
    expect(parseFileList("'file\"name.txt'")).toEqual(['file"name.txt'])
  })
})

// ==================== Unit tests: isValidBase64 ====================

describe('isValidBase64', () => {
  test('returns true for valid base64', () => {
    const valid = Buffer.from('hello world').toString('base64')
    expect(isValidBase64(valid)).toBe(true)
  })

  test('returns false for invalid base64', () => {
    expect(isValidBase64('not-valid-base64!!!')).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(isValidBase64('')).toBe(false)
  })

  test('returns false for null-ish', () => {
    expect(isValidBase64(undefined as unknown as string)).toBe(false)
  })

  test('returns true for base64 with newlines', () => {
    const valid = Buffer.from('hello world').toString('base64')
    const withNewlines = valid.match(/.{1,4}/g)!.join('\n')
    expect(isValidBase64(withNewlines)).toBe(true)
  })

  test('returns true for base64 with spaces and tabs', () => {
    const valid = Buffer.from('test data').toString('base64')
    const withSpaces = valid.match(/.{1,4}/g)!.join(' \t')
    expect(isValidBase64(withSpaces)).toBe(true)
  })
})

// ==================== Unit tests: resolveBranch ====================

describe('resolveBranch', () => {
  test('returns input branch when provided', () => {
    expect(resolveBranch('custom-branch')).toBe('custom-branch')
  })

  test('returns GITHUB_HEAD_REF when set', () => {
    process.env.GITHUB_HEAD_REF = 'pr-branch'
    expect(resolveBranch('')).toBe('pr-branch')
  })

  test('extracts branch name from refs/heads/', () => {
    process.env.GITHUB_REF = 'refs/heads/feature-x'
    expect(resolveBranch('')).toBe('feature-x')
  })

  test('extracts tag name from refs/tags/', () => {
    process.env.GITHUB_REF = 'refs/tags/v1.0.0'
    expect(resolveBranch('')).toBe('v1.0.0')
  })

  test('falls back to main when nothing is set', () => {
    expect(resolveBranch('')).toBe('main')
  })

  test('GITHUB_HEAD_REF takes precedence over GITHUB_REF', () => {
    process.env.GITHUB_HEAD_REF = 'pr-branch'
    process.env.GITHUB_REF = 'refs/heads/main'
    expect(resolveBranch('')).toBe('pr-branch')
  })

  test('input branch takes precedence over all env vars', () => {
    process.env.GITHUB_HEAD_REF = 'pr-branch'
    process.env.GITHUB_REF = 'refs/heads/main'
    expect(resolveBranch('override')).toBe('override')
  })
})

// ==================== Unit tests: getInputs ====================

describe('getInputs', () => {
  test('parses valid inputs', () => {
    mockInputs({
      commit_message: 'test commit',
      files: 'file.txt',
      branch: 'main',
      author_name: 'Test',
      author_email: 'test@test.com',
      force_push: 'true',
      skip_if_no_changes: 'true',
      skip_hooks: 'true'
    })
    const inputs = getInputs()
    expect(inputs.commitMessage).toBe('test commit')
    expect(inputs.files).toBe('file.txt')
    expect(inputs.branch).toBe('main')
    expect(inputs.authorName).toBe('Test')
    expect(inputs.authorEmail).toBe('test@test.com')
    expect(inputs.forcePush).toBe(true)
    expect(inputs.skipIfNoChanges).toBe(true)
    expect(inputs.skipHooks).toBe(true)
  })

  test('throws when commit_message is missing and no commits', () => {
    mockInputs({})
    expect(() => getInputs()).toThrow('commit_message is required')
  })

  test('warns about deprecated commit_name', () => {
    mockInputs({commit_name: 'old style'})
    const inputs = getInputs()
    expect(inputs.commitMessage).toBe('old style')
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('deprecated')
    )
  })

  test('trims commit message whitespace', () => {
    mockInputs({commit_message: '  test  '})
    expect(getInputs().commitMessage).toBe('test')
  })

  test('parses commits JSON array', () => {
    mockInputs({
      commits: JSON.stringify([
        {message: 'commit 1', files: 'a.txt'},
        {message: 'commit 2'}
      ])
    })
    const inputs = getInputs()
    expect(inputs.commits).toHaveLength(2)
    expect(inputs.commits[0].message).toBe('commit 1')
    expect(inputs.commits[0].files).toBe('a.txt')
    expect(inputs.commits[1].message).toBe('commit 2')
  })

  test('throws for invalid commits JSON', () => {
    mockInputs({commits: 'not json'})
    expect(() => getInputs()).toThrow('Invalid JSON')
  })

  test('throws when commits is not an array', () => {
    mockInputs({commits: '{"message": "test"}'})
    expect(() => getInputs()).toThrow('commits must be a JSON array')
  })

  test('throws when commit in array has no message', () => {
    mockInputs({commits: JSON.stringify([{files: 'a.txt'}])})
    expect(() => getInputs()).toThrow('must have a "message" field')
  })

  test('allows empty commit_message when commits array is provided', () => {
    mockInputs({commits: JSON.stringify([{message: 'test'}])})
    expect(() => getInputs()).not.toThrow()
  })

  test('force_push treats invalid values as false', () => {
    mockInputs({commit_message: 'test', force_push: 'yes'})
    expect(getInputs().forcePush).toBe(false)
  })

  test('force_push is false when set to false', () => {
    mockInputs({commit_message: 'test', force_push: 'false'})
    expect(getInputs().forcePush).toBe(false)
  })

  test('force_push is true when set to true', () => {
    mockInputs({commit_message: 'test', force_push: 'true'})
    expect(getInputs().forcePush).toBe(true)
  })

  test('skip_hooks defaults to true when not set', () => {
    mockInputs({commit_message: 'test'})
    expect(getInputs().skipHooks).toBe(true)
  })

  test('skip_hooks is false only when explicitly set to false', () => {
    mockInputs({commit_message: 'test', skip_hooks: 'false'})
    expect(getInputs().skipHooks).toBe(false)
  })

  test('defaults to GITHUB_ACTOR for author', () => {
    process.env.GITHUB_ACTOR = 'octocat'
    mockInputs({commit_message: 'test'})
    const inputs = getInputs()
    expect(inputs.authorName).toBe('octocat')
    expect(inputs.authorEmail).toBe('octocat@users.noreply.github.com')
  })

  test('falls back to github-actions when GITHUB_ACTOR is not set', () => {
    mockInputs({commit_message: 'test'})
    const inputs = getInputs()
    expect(inputs.authorName).toBe('github-actions')
    expect(inputs.authorEmail).toBe('github-actions@users.noreply.github.com')
  })

  test('defaults files to -A', () => {
    mockInputs({commit_message: 'test'})
    expect(getInputs().files).toBe('-A')
  })

  test('parses all boolean inputs', () => {
    mockInputs({
      commit_message: 'test',
      sign_commit: 'true',
      dry_run: 'true',
      create_branch: 'true',
      create_pr: 'true'
    })
    const inputs = getInputs()
    expect(inputs.signCommit).toBe(true)
    expect(inputs.dryRun).toBe(true)
    expect(inputs.createBranch).toBe(true)
    expect(inputs.createPr).toBe(true)
  })
})

// ==================== Integration tests: run ====================

describe('run', () => {
  const defaultInputs: Record<string, string> = {
    commit_message: 'test commit',
    files: '-A',
    skip_if_no_changes: 'true',
    force_push: 'true',
    skip_hooks: 'true'
  }

  // ---------- Basic commit flow ----------

  describe('basic commit flow', () => {
    test('skips commit when no changes and skip_if_no_changes=true', async () => {
      mockInputs({...defaultInputs, skip_if_no_changes: 'true'})
      mockExecDefault({hasChanges: false})

      await run()

      expect(mockSetOutput).toHaveBeenCalledWith('committed', 'false')
      expect(mockSetOutput).toHaveBeenCalledWith('commit_sha', '')
      expect(mockSetOutput).toHaveBeenCalledWith('commit_shas', '[]')

      const commitCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCalls).toHaveLength(0)
    })

    test('creates empty commit when no changes and skip_if_no_changes=false', async () => {
      mockInputs({...defaultInputs, skip_if_no_changes: 'false'})
      mockExecDefault({hasChanges: false, commitSha: 'sha123'})

      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCall).toBeDefined()
      expect(commitCall![1]).toContain('--allow-empty')
      expect(mockSetOutput).toHaveBeenCalledWith('committed', 'true')
    })

    test('commits and pushes when changes detected', async () => {
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'abc123'})

      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCall).toBeDefined()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall).toBeDefined()

      expect(mockSetOutput).toHaveBeenCalledWith('committed', 'true')
      expect(mockSetOutput).toHaveBeenCalledWith('commit_sha', 'abc123')
    })

    test('uses --local for git config (not --global)', async () => {
      mockInputs(defaultInputs)
      mockExecDefault()

      await run()

      const configCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'config'
      )
      expect(configCalls.length).toBeGreaterThanOrEqual(2)
      for (const call of configCalls) {
        expect(call[1]).toContain('--local')
        expect(call[1]).not.toContain('--global')
      }
    })

    test('calls setFailed only once on error (no double reporting)', async () => {
      mockInputs({})
      await run()
      expect(mockSetFailed).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- Commit options ----------

  describe('commit options', () => {
    test('includes --no-verify when skip_hooks=true', async () => {
      mockInputs({...defaultInputs, skip_hooks: 'true'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCall![1]).toContain('--no-verify')
    })

    test('omits --no-verify when skip_hooks=false', async () => {
      mockInputs({...defaultInputs, skip_hooks: 'false'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCall![1]).not.toContain('--no-verify')
    })

    test('includes commit body in message', async () => {
      mockInputs({
        ...defaultInputs,
        commit_body: 'This is the body'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msgIndex = (commitCall![1] as string[]).indexOf('-m') + 1
      const message = commitCall![1][msgIndex] as string
      expect(message).toContain('test commit')
      expect(message).toContain('\n\nThis is the body')
    })

    test('does not force push when force_push=false', async () => {
      mockInputs({...defaultInputs, force_push: 'false'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).not.toContain('-f')
    })

    test('force pushes when force_push=true', async () => {
      mockInputs({...defaultInputs, force_push: 'true'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).toContain('-f')
    })

    test('force_push with invalid value treated as false', async () => {
      mockInputs({...defaultInputs, force_push: 'yes'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).not.toContain('-f')
    })
  })

  // ---------- Author handling ----------

  describe('author handling', () => {
    test('uses GITHUB_ACTOR as default author', async () => {
      process.env.GITHUB_ACTOR = 'octocat'
      mockInputs(defaultInputs)
      mockExecDefault()

      await run()

      const nameCall = mockExecFn.mock.calls.find(
        (c: any[]) =>
          c[0] === 'git' &&
          c[1]?.[0] === 'config' &&
          c[1]?.includes('user.name')
      )
      expect(nameCall![1]).toContain('octocat')
    })

    test('uses custom author name and email', async () => {
      mockInputs({
        ...defaultInputs,
        author_name: 'Custom Bot',
        author_email: 'bot@example.com'
      })
      mockExecDefault()

      await run()

      const nameCall = mockExecFn.mock.calls.find(
        (c: any[]) =>
          c[0] === 'git' &&
          c[1]?.[0] === 'config' &&
          c[1]?.includes('user.name')
      )
      const emailCall = mockExecFn.mock.calls.find(
        (c: any[]) =>
          c[0] === 'git' &&
          c[1]?.[0] === 'config' &&
          c[1]?.includes('user.email')
      )
      expect(nameCall![1]).toContain('Custom Bot')
      expect(emailCall![1]).toContain('bot@example.com')
    })
  })

  // ---------- File handling ----------

  describe('file handling', () => {
    test('adds all files with -A', async () => {
      mockInputs({...defaultInputs, files: '-A'})
      mockExecDefault()

      await run()

      const addCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'add'
      )
      expect(addCall![1]).toEqual(['add', '-A'])
    })

    test('adds individual files from file list', async () => {
      mockInputs({...defaultInputs, files: 'a.txt b.txt'})
      mockExecDefault()

      await run()

      const addCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'add'
      )
      expect(addCalls).toHaveLength(2)
      expect(addCalls[0][1]).toEqual(['add', 'a.txt'])
      expect(addCalls[1][1]).toEqual(['add', 'b.txt'])
    })

    test('handles quoted paths with spaces', async () => {
      mockInputs({
        ...defaultInputs,
        files: 'a.txt "file with spaces.txt" b.txt'
      })
      mockExecDefault()

      await run()

      const addCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'add'
      )
      expect(addCalls).toHaveLength(3)
      expect(addCalls[1][1]).toEqual(['add', 'file with spaces.txt'])
    })
  })

  // ---------- Outputs ----------

  describe('outputs', () => {
    test('sets commit_url using GitHub env vars', async () => {
      process.env.GITHUB_SERVER_URL = 'https://github.com'
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'abc123'})

      await run()

      expect(mockSetOutput).toHaveBeenCalledWith(
        'commit_url',
        'https://github.com/owner/repo/commit/abc123'
      )
    })

    test('sets commit_shas as JSON array', async () => {
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'abc123'})

      await run()

      expect(mockSetOutput).toHaveBeenCalledWith(
        'commit_shas',
        JSON.stringify(['abc123'])
      )
    })

    test('sets committed=false and empty outputs when skipping', async () => {
      mockInputs({...defaultInputs, skip_if_no_changes: 'true'})
      mockExecDefault({hasChanges: false})

      await run()

      expect(mockSetOutput).toHaveBeenCalledWith('committed', 'false')
      expect(mockSetOutput).toHaveBeenCalledWith('commit_sha', '')
      expect(mockSetOutput).toHaveBeenCalledWith('commit_shas', '[]')
      expect(mockSetOutput).toHaveBeenCalledWith('commit_url', '')
    })

    test('sets empty commit_url when GITHUB_REPOSITORY is not set', async () => {
      delete process.env.GITHUB_REPOSITORY
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'abc123'})

      await run()

      expect(mockSetOutput).toHaveBeenCalledWith('commit_url', '')
    })
  })

  // ---------- GPG signing ----------

  describe('GPG signing', () => {
    test('errors when gpg_private_key is missing', async () => {
      mockInputs({...defaultInputs, sign_commit: 'true'})
      mockExecDefault()

      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('GPG private key is required')
      )
    })

    test('errors for invalid base64 GPG key', async () => {
      mockInputs({
        ...defaultInputs,
        sign_commit: 'true',
        gpg_private_key: 'not-valid-base64!!!'
      })
      mockExecDefault()

      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('valid base64')
      )
    })

    test('errors for non-PGP key after base64 decode', async () => {
      mockInputs({
        ...defaultInputs,
        sign_commit: 'true',
        gpg_private_key: Buffer.from('not a pgp key').toString('base64')
      })
      mockExecDefault()

      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('valid PGP key')
      )
    })

    test('accepts GPG key with newlines in base64', async () => {
      const pgpKey =
        '-----BEGIN PGP PRIVATE KEY BLOCK-----\ntest\n-----END PGP PRIVATE KEY BLOCK-----'
      const base64 = Buffer.from(pgpKey).toString('base64')
      const base64WithNewlines = base64.match(/.{1,20}/g)!.join('\n')

      mockInputs({
        ...defaultInputs,
        sign_commit: 'true',
        gpg_private_key: base64WithNewlines
      })
      mockExecDefault()

      await run()

      // Should not fail on base64 validation - may fail later on GPG import
      // but the base64 parsing itself should succeed
      expect(mockSetFailed).not.toHaveBeenCalledWith(
        expect.stringContaining('valid base64')
      )
    })
  })

  // ---------- Dry run ----------

  describe('dry run', () => {
    test('does not commit or push in dry run mode', async () => {
      mockInputs({...defaultInputs, dry_run: 'true'})
      mockExecDefault({hasChanges: true, stagedFiles: 'M\tfile.txt\n'})

      await run()

      const commitCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const pushCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(commitCalls).toHaveLength(0)
      expect(pushCalls).toHaveLength(0)
      expect(mockSetOutput).toHaveBeenCalledWith('committed', 'false')
    })

    test('logs dry run info for staged files', async () => {
      mockInputs({...defaultInputs, dry_run: 'true'})
      mockExecDefault({hasChanges: true, stagedFiles: 'M\tfile.txt\n'})

      await run()

      expect(mockInfo).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN]')
      )
    })

    test('resets staging area after dry run', async () => {
      mockInputs({...defaultInputs, dry_run: 'true'})
      mockExecDefault({hasChanges: true})

      await run()

      const resetCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'reset'
      )
      expect(resetCall).toBeDefined()
    })

    test('sets all outputs to empty in dry run', async () => {
      mockInputs({...defaultInputs, dry_run: 'true'})
      mockExecDefault({hasChanges: true})

      await run()

      expect(mockSetOutput).toHaveBeenCalledWith('committed', 'false')
      expect(mockSetOutput).toHaveBeenCalledWith('commit_sha', '')
      expect(mockSetOutput).toHaveBeenCalledWith('commit_shas', '[]')
      expect(mockSetOutput).toHaveBeenCalledWith('commit_url', '')
    })
  })

  // ---------- Tagging ----------

  describe('tagging', () => {
    test('creates and pushes lightweight tag', async () => {
      mockInputs({...defaultInputs, tag: 'v1.0.0'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const tagCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'tag'
      )
      expect(tagCall![1]).toEqual(['tag', 'v1.0.0'])

      const tagPush = mockExecFn.mock.calls.find(
        (c: any[]) =>
          c[0] === 'git' && c[1]?.[0] === 'push' && c[1]?.includes('v1.0.0')
      )
      expect(tagPush).toBeDefined()
    })

    test('creates annotated tag with message', async () => {
      mockInputs({
        ...defaultInputs,
        tag: 'v1.0.0',
        tag_message: 'Release 1.0'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const tagCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'tag'
      )
      expect(tagCall![1]).toEqual(['tag', '-a', 'v1.0.0', '-m', 'Release 1.0'])
    })

    test('does not tag when no commits were made', async () => {
      mockInputs({
        ...defaultInputs,
        tag: 'v1.0.0',
        skip_if_no_changes: 'true'
      })
      mockExecDefault({hasChanges: false})

      await run()

      const tagCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'tag'
      )
      expect(tagCall).toBeUndefined()
    })
  })

  // ---------- Branch creation ----------

  describe('branch creation', () => {
    test('pushes with refs/heads/ prefix when create_branch=true', async () => {
      mockInputs({
        ...defaultInputs,
        branch: 'new-branch',
        create_branch: 'true'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).toContain('HEAD:refs/heads/new-branch')
    })

    test('pushes without refs/heads/ prefix by default', async () => {
      mockInputs({...defaultInputs, branch: 'existing-branch'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).toContain('HEAD:existing-branch')
      expect(pushCall![1]).not.toContain('refs/heads/')
    })
  })

  // ---------- Token authentication ----------

  describe('token authentication', () => {
    test('sets remote URL with token', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_SERVER_URL = 'https://github.com'
      mockInputs({...defaultInputs, token: 'ghp_test123'})
      mockExecDefault()

      await run()

      const remoteCall = mockExecFn.mock.calls.find(
        (c: any[]) =>
          c[0] === 'git' && c[1]?.[0] === 'remote' && c[1]?.[1] === 'set-url'
      )
      expect(remoteCall).toBeDefined()
      expect(remoteCall![1][3]).toContain('x-access-token:ghp_test123')
      expect(remoteCall![1][3]).toContain('github.com/owner/repo.git')
    })

    test('masks token with core.setSecret', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      mockInputs({...defaultInputs, token: 'ghp_test123'})
      mockExecDefault()

      await run()

      expect(mockSetSecret).toHaveBeenCalledWith('ghp_test123')
    })

    test('sets remote URL silently', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      mockInputs({...defaultInputs, token: 'ghp_test123'})
      mockExecDefault()

      await run()

      const remoteCall = mockExecFn.mock.calls.find(
        (c: any[]) =>
          c[0] === 'git' && c[1]?.[0] === 'remote' && c[1]?.[1] === 'set-url'
      )
      expect(remoteCall![2]).toEqual({silent: true})
    })
  })

  // ---------- PR creation ----------

  describe('PR creation', () => {
    test('creates PR after push and sets outputs', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_API_URL = 'https://api.github.com'
      mockInputs({
        ...defaultInputs,
        create_pr: 'true',
        token: 'ghp_test',
        pr_title: 'My PR',
        pr_base_branch: 'main',
        branch: 'feature'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/owner/repo/pull/42',
          number: 42
        })
      })

      await run()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/pulls',
        expect.objectContaining({method: 'POST'})
      )
      expect(mockSetOutput).toHaveBeenCalledWith(
        'pr_url',
        'https://github.com/owner/repo/pull/42'
      )
      expect(mockSetOutput).toHaveBeenCalledWith('pr_number', '42')
    })

    test('errors when token is missing for create_pr', async () => {
      mockInputs({...defaultInputs, create_pr: 'true'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('token is required')
      )
    })

    test('fetches default branch when pr_base_branch not set', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_API_URL = 'https://api.github.com'
      mockInputs({
        ...defaultInputs,
        create_pr: 'true',
        token: 'ghp_test',
        branch: 'feature'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      ;(global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({default_branch: 'main'})
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            html_url: 'https://github.com/owner/repo/pull/1',
            number: 1
          })
        })

      await run()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo',
        expect.any(Object)
      )
    })

    test('uses commit_message as default PR title', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_API_URL = 'https://api.github.com'
      mockInputs({
        ...defaultInputs,
        create_pr: 'true',
        token: 'ghp_test',
        pr_base_branch: 'main',
        branch: 'feature'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/owner/repo/pull/1',
          number: 1
        })
      })

      await run()

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
      const body = JSON.parse(fetchCall[1].body as string)
      expect(body.title).toBe('test commit')
    })

    test('handles PR creation API failure', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_API_URL = 'https://api.github.com'
      mockInputs({
        ...defaultInputs,
        create_pr: 'true',
        token: 'ghp_test',
        pr_base_branch: 'main',
        branch: 'feature'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        text: async () => 'Validation failed'
      })

      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create PR')
      )
    })
  })

  // ---------- Multi-commit ----------

  describe('multi-commit', () => {
    test('processes multiple commits in sequence', async () => {
      mockInputs({
        ...defaultInputs,
        commits: JSON.stringify([
          {message: 'commit 1', files: 'a.txt'},
          {message: 'commit 2', files: 'b.txt'}
        ])
      })

      let revParseCount = 0
      mockExecFn.mockImplementation(
        async (cmd: string, args?: string[], opts?: any): Promise<number> => {
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--quiet'
          ) {
            return 1
          }
          if (cmd === 'git' && args?.[0] === 'rev-parse') {
            revParseCount++
            opts?.listeners?.stdout?.(Buffer.from(`sha${revParseCount}\n`))
            return 0
          }
          return 0
        }
      )

      await run()

      const commitCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCalls).toHaveLength(2)

      const msg1Index = (commitCalls[0][1] as string[]).indexOf('-m') + 1
      const msg2Index = (commitCalls[1][1] as string[]).indexOf('-m') + 1
      expect(commitCalls[0][1][msg1Index]).toBe('commit 1')
      expect(commitCalls[1][1][msg2Index]).toBe('commit 2')

      expect(mockSetOutput).toHaveBeenCalledWith(
        'commit_shas',
        JSON.stringify(['sha1', 'sha2'])
      )
      expect(mockSetOutput).toHaveBeenCalledWith('commit_sha', 'sha2')
    })

    test('uses per-commit files', async () => {
      mockInputs({
        ...defaultInputs,
        commits: JSON.stringify([
          {message: 'commit 1', files: 'a.txt'},
          {message: 'commit 2', files: 'b.txt'}
        ])
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const addCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'add'
      )
      const addedFiles = addCalls.map((c: any[]) => c[1][1])
      expect(addedFiles).toContain('a.txt')
      expect(addedFiles).toContain('b.txt')
    })

    test('falls back to default files when commit has no files', async () => {
      mockInputs({
        ...defaultInputs,
        files: '-A',
        commits: JSON.stringify([{message: 'commit 1'}])
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const addCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'add'
      )
      expect(addCall![1]).toEqual(['add', '-A'])
    })

    test('only pushes once for multiple commits', async () => {
      mockInputs({
        ...defaultInputs,
        commits: JSON.stringify([{message: 'commit 1'}, {message: 'commit 2'}])
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCalls = mockExecFn.mock.calls.filter(
        (c: any[]) =>
          c[0] === 'git' && c[1]?.[0] === 'push' && !c[1]?.includes('v') // exclude tag pushes
      )
      expect(pushCalls).toHaveLength(1)
    })
  })

  // ---------- Branch resolution in run context ----------

  describe('branch resolution in run', () => {
    test('uses GITHUB_REF for tag events correctly', async () => {
      process.env.GITHUB_REF = 'refs/tags/v2.0.0'
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).toContain('HEAD:v2.0.0')
    })

    test('uses GITHUB_REF for branch events', async () => {
      process.env.GITHUB_REF = 'refs/heads/develop'
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).toContain('HEAD:develop')
    })

    test('uses explicit branch input over env vars', async () => {
      process.env.GITHUB_REF = 'refs/heads/develop'
      mockInputs({...defaultInputs, branch: 'custom'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).toContain('HEAD:custom')
    })

    test('falls back to main when no branch info available', async () => {
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).toContain('HEAD:main')
    })
  })

  // ---------- Deprecated inputs ----------

  describe('deprecated inputs', () => {
    test('uses commit_name when commit_message is not set', async () => {
      mockInputs({
        ...defaultInputs,
        commit_message: '',
        commit_name: 'old style msg'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      await run()

      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('deprecated')
      )

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msgIndex = (commitCall![1] as string[]).indexOf('-m') + 1
      expect(commitCall![1][msgIndex]).toBe('old style msg')
    })
  })

  // ---------- Error handling ----------

  describe('error handling', () => {
    test('setFailed is called with error message', async () => {
      mockInputs({})

      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('commit_message is required')
      )
    })

    test('does not throw (errors are caught internally)', async () => {
      mockInputs({})

      await expect(run()).resolves.toBeUndefined()
    })
  })
})
