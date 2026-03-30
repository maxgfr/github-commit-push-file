/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/require-await */

jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  setOutput: jest.fn(),
  setSecret: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn(),
  summary: {
    addHeading: jest.fn(),
    addTable: jest.fn(),
    addList: jest.fn(),
    write: jest.fn()
  }
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
  getInputs,
  expandTemplateVars,
  buildTemplateVars
} from '../main'

const mockGetInput = core.getInput as jest.Mock
const mockSetOutput = core.setOutput as jest.Mock
const mockSetSecret = core.setSecret as jest.Mock
const mockWarning = core.warning as jest.Mock
const mockSetFailed = core.setFailed as jest.Mock
const mockExecFn = exec.exec as jest.Mock
const mockSummary = core.summary as unknown as Record<string, jest.Mock>

const savedEnv = {...process.env}

// ==================== Helpers ====================

const mockInputs = (inputs: Record<string, string>): void => {
  mockGetInput.mockImplementation((name: string) => inputs[name] || '')
}

const mockExecDefault = (options?: {
  hasChanges?: boolean
  commitSha?: string
  stagedFiles?: string
  changedFiles?: string
}): void => {
  const {
    hasChanges: changes = false,
    commitSha = 'abc123def456',
    stagedFiles = '',
    changedFiles = ''
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
        if (args?.[1] === '--cached' && args?.[2] === '--name-only') {
          if (opts?.listeners?.stdout && changedFiles) {
            opts.listeners.stdout(Buffer.from(changedFiles))
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
  delete process.env.GIT_AUTHOR_DATE
  delete process.env.GIT_COMMITTER_DATE
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

  test('falls back to main for unknown ref format like refs/pull', () => {
    process.env.GITHUB_REF = 'refs/pull/123/merge'
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

  test('throws for empty commits array', () => {
    mockInputs({commits: '[]'})
    expect(() => getInputs()).toThrow('commits array must not be empty')
  })

  test('allows empty commit_message when commits array is provided', () => {
    mockInputs({commits: JSON.stringify([{message: 'test'}])})
    expect(() => getInputs()).not.toThrow()
  })

  test('throws when amend is used with commits array', () => {
    mockInputs({
      amend: 'true',
      commits: JSON.stringify([{message: 'test'}])
    })
    expect(() => getInputs()).toThrow(
      'amend cannot be used with the commits array'
    )
  })

  test('force_push treats invalid values as false', () => {
    mockInputs({commit_message: 'test', force_push: 'yes'})
    expect(getInputs().forcePush).toBe(false)
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
  })

  test('defaults files to -A', () => {
    mockInputs({commit_message: 'test'})
    expect(getInputs().files).toBe('-A')
  })

  test('parses new boolean inputs', () => {
    mockInputs({
      commit_message: 'test',
      amend: 'true',
      retry_on_conflict: 'true',
      create_branch: 'true',
      create_pr: 'true',
      dry_run: 'true'
    })
    const inputs = getInputs()
    expect(inputs.amend).toBe(true)
    expect(inputs.retryOnConflict).toBe(true)
    expect(inputs.createBranch).toBe(true)
    expect(inputs.createPr).toBe(true)
    expect(inputs.dryRun).toBe(true)
  })

  test('parses max_retries with default of 3', () => {
    mockInputs({commit_message: 'test'})
    expect(getInputs().maxRetries).toBe(3)
  })

  test('parses custom max_retries', () => {
    mockInputs({commit_message: 'test', max_retries: '5'})
    expect(getInputs().maxRetries).toBe(5)
  })

  test('clamps max_retries to at least 1', () => {
    mockInputs({commit_message: 'test', max_retries: '0'})
    expect(getInputs().maxRetries).toBe(1)
  })

  test('handles invalid max_retries', () => {
    mockInputs({commit_message: 'test', max_retries: 'abc'})
    expect(getInputs().maxRetries).toBe(3)
  })

  test('parses string inputs for new features', () => {
    mockInputs({
      commit_message: 'test',
      exclude_files: '*.env',
      pathspec_from_file: 'files.txt',
      commit_timestamp: '2024-01-01T00:00:00Z'
    })
    const inputs = getInputs()
    expect(inputs.excludeFiles).toBe('*.env')
    expect(inputs.pathspecFromFile).toBe('files.txt')
    expect(inputs.commitTimestamp).toBe('2024-01-01T00:00:00Z')
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
      expect(mockSetOutput).toHaveBeenCalledWith('changed_files', '[]')

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

    test('calls setFailed only once on error', async () => {
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
      mockInputs({...defaultInputs, commit_body: 'This is the body'})
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
      expect(nameCall![1]).toContain('Custom Bot')
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

    test('sets changed_files output', async () => {
      mockInputs(defaultInputs)
      mockExecDefault({
        hasChanges: true,
        commitSha: 'abc123',
        changedFiles: 'file1.txt\nfile2.txt\n'
      })
      await run()

      expect(mockSetOutput).toHaveBeenCalledWith(
        'changed_files',
        JSON.stringify(['file1.txt', 'file2.txt'])
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
      expect(mockSetOutput).toHaveBeenCalledWith('changed_files', '[]')
    })

    test('sets empty commit_url when GITHUB_REPOSITORY is not set', async () => {
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

      expect(mockSetFailed).not.toHaveBeenCalledWith(
        expect.stringContaining('valid base64')
      )
    })

    test('adds -S flag for signed commits', async () => {
      const pgpKey =
        '-----BEGIN PGP PRIVATE KEY BLOCK-----\ndata\n-----END PGP PRIVATE KEY BLOCK-----'
      const base64Key = Buffer.from(pgpKey).toString('base64')

      mockInputs({
        ...defaultInputs,
        sign_commit: 'true',
        gpg_private_key: base64Key
      })

      // Real fs ops are safe (temp dirs). Only exec is mocked.
      mockExecFn.mockImplementation(
        async (cmd: string, args?: string[], opts?: any): Promise<number> => {
          if (cmd === 'gpg' && args?.[0] === '--list-secret-keys') {
            opts?.listeners?.stdout?.(
              Buffer.from('sec:u:4096:1:ABCDEF1234567890:1234567890:::\n')
            )
            return 0
          }
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--quiet'
          ) {
            return 1
          }
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--name-only'
          ) {
            opts?.listeners?.stdout?.(Buffer.from('file.txt\n'))
            return 0
          }
          if (cmd === 'git' && args?.[0] === 'rev-parse') {
            opts?.listeners?.stdout?.(Buffer.from('sha1\n'))
            return 0
          }
          return 0
        }
      )

      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCall![1]).toContain('-S')

      // Verify GPG signing key was configured
      const signingKeyCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.includes('user.signingkey')
      )
      expect(signingKeyCall).toBeDefined()
      expect(signingKeyCall![1]).toContain('ABCDEF1234567890')
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
      expect(mockSetOutput).toHaveBeenCalledWith('changed_files', '[]')
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

    test('strips existing refs/heads/ prefix to avoid double-prefixing', async () => {
      mockInputs({
        ...defaultInputs,
        branch: 'refs/heads/my-branch',
        create_branch: 'true'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).toContain('HEAD:refs/heads/my-branch')
      expect(pushCall![1]).not.toContain('refs/heads/refs/heads/')
    })

    test('pushes without refs/heads/ prefix by default', async () => {
      mockInputs({...defaultInputs, branch: 'existing-branch'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall![1]).toContain('HEAD:existing-branch')
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
      expect(remoteCall![1][3]).toContain('x-access-token:ghp_test123')
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

    test('handles repo info fetch failure', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_API_URL = 'https://api.github.com'
      mockInputs({
        ...defaultInputs,
        create_pr: 'true',
        token: 'ghp_test',
        branch: 'feature'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      ;(global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        statusText: 'Not Found'
      })
      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to get repository info')
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
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--name-only'
          ) {
            opts?.listeners?.stdout?.(Buffer.from('file.txt\n'))
            return 0
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

      // sha1 is consumed by the initial rev-parse for template vars
      // so commit rev-parses get sha2 and sha3
      expect(mockSetOutput).toHaveBeenCalledWith(
        'commit_shas',
        JSON.stringify(['sha2', 'sha3'])
      )
      expect(mockSetOutput).toHaveBeenCalledWith('commit_sha', 'sha3')
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
          c[0] === 'git' && c[1]?.[0] === 'push' && !c[1]?.includes('v')
      )
      expect(pushCalls).toHaveLength(1)
    })
  })

  // ---------- Amend ----------

  describe('amend', () => {
    test('adds --amend to commit args', async () => {
      mockInputs({...defaultInputs, amend: 'true'})
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCall![1]).toContain('--amend')
    })

    test('proceeds even with no changes when amend=true', async () => {
      mockInputs({
        ...defaultInputs,
        amend: 'true',
        skip_if_no_changes: 'true'
      })
      mockExecDefault({hasChanges: false, commitSha: 'sha1'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCall).toBeDefined()
      expect(commitCall![1]).toContain('--amend')
      // Should NOT have --allow-empty (amend handles this)
      expect(commitCall![1]).not.toContain('--allow-empty')
    })

    test('does not add --amend by default', async () => {
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      expect(commitCall![1]).not.toContain('--amend')
    })
  })

  // ---------- Exclude files ----------

  describe('exclude files', () => {
    test('resets excluded files after staging', async () => {
      mockInputs({
        ...defaultInputs,
        exclude_files: '*.env secret.txt'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const resetCalls = mockExecFn.mock.calls.filter(
        (c: any[]) =>
          c[0] === 'git' && c[1]?.[0] === 'reset' && c[1]?.[1] === 'HEAD'
      )
      expect(resetCalls).toHaveLength(2)
      expect(resetCalls[0][1]).toEqual(['reset', 'HEAD', '--', '*.env'])
      expect(resetCalls[1][1]).toEqual(['reset', 'HEAD', '--', 'secret.txt'])
    })

    test('does not reset if exclude_files is empty', async () => {
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const resetCalls = mockExecFn.mock.calls.filter(
        (c: any[]) =>
          c[0] === 'git' && c[1]?.[0] === 'reset' && c[1]?.[1] === 'HEAD'
      )
      expect(resetCalls).toHaveLength(0)
    })
  })

  // ---------- Pathspec from file ----------

  describe('pathspec from file', () => {
    test('uses --pathspec-from-file when set', async () => {
      mockInputs({
        ...defaultInputs,
        pathspec_from_file: 'files-to-add.txt'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const addCall = mockExecFn.mock.calls.find(
        (c: any[]) =>
          c[0] === 'git' &&
          c[1]?.[0] === 'add' &&
          c[1]?.includes('--pathspec-from-file')
      )
      expect(addCall).toBeDefined()
      expect(addCall![1]).toEqual([
        'add',
        '--pathspec-from-file',
        'files-to-add.txt'
      ])
    })

    test('pathspec_from_file takes precedence over files input', async () => {
      mockInputs({
        ...defaultInputs,
        files: 'a.txt b.txt',
        pathspec_from_file: 'files.txt'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      // Should use pathspec-from-file, not individual adds
      const pathspecCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.includes('--pathspec-from-file')
      )
      expect(pathspecCall).toBeDefined()

      // Should NOT add individual files
      const individualAdds = mockExecFn.mock.calls.filter(
        (c: any[]) =>
          c[0] === 'git' &&
          c[1]?.[0] === 'add' &&
          !c[1]?.includes('--pathspec-from-file')
      )
      expect(individualAdds).toHaveLength(0)
    })
  })

  // ---------- Commit timestamp ----------

  describe('commit timestamp', () => {
    test('sets GIT_AUTHOR_DATE and GIT_COMMITTER_DATE env vars', async () => {
      mockInputs({
        ...defaultInputs,
        commit_timestamp: '2024-01-01T00:00:00Z'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})

      // Track env vars at commit time
      let authorDate: string | undefined
      let committerDate: string | undefined
      mockExecFn.mockImplementation(
        async (cmd: string, args?: string[], opts?: any): Promise<number> => {
          if (cmd === 'git' && args?.[0] === 'commit') {
            authorDate = process.env.GIT_AUTHOR_DATE
            committerDate = process.env.GIT_COMMITTER_DATE
            return 0
          }
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--quiet'
          ) {
            return 1
          }
          if (cmd === 'git' && args?.[0] === 'rev-parse') {
            opts?.listeners?.stdout?.(Buffer.from('sha1\n'))
            return 0
          }
          return 0
        }
      )

      await run()

      expect(authorDate).toBe('2024-01-01T00:00:00Z')
      expect(committerDate).toBe('2024-01-01T00:00:00Z')
      // Should be cleaned up after commit
      expect(process.env.GIT_AUTHOR_DATE).toBeUndefined()
      expect(process.env.GIT_COMMITTER_DATE).toBeUndefined()
    })

    test('does not set timestamp env vars when not provided', async () => {
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      expect(process.env.GIT_AUTHOR_DATE).toBeUndefined()
      expect(process.env.GIT_COMMITTER_DATE).toBeUndefined()
    })
  })

  // ---------- Push retry ----------

  describe('push retry on conflict', () => {
    test('retries push after failure with pull --rebase', async () => {
      mockInputs({
        ...defaultInputs,
        force_push: 'false',
        retry_on_conflict: 'true',
        max_retries: '3'
      })

      let pushCount = 0
      mockExecFn.mockImplementation(
        async (cmd: string, args?: string[], opts?: any): Promise<number> => {
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--quiet'
          ) {
            return 1
          }
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--name-only'
          ) {
            opts?.listeners?.stdout?.(Buffer.from('file.txt\n'))
            return 0
          }
          if (cmd === 'git' && args?.[0] === 'rev-parse') {
            opts?.listeners?.stdout?.(Buffer.from('sha1\n'))
            return 0
          }
          if (cmd === 'git' && args?.[0] === 'push') {
            pushCount++
            return pushCount <= 1 ? 1 : 0
          }
          return 0
        }
      )

      await run()

      // Should have pushed twice (fail + succeed)
      const pushCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCalls).toHaveLength(2)

      // Should have pulled with rebase between attempts
      const pullCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'pull'
      )
      expect(pullCall).toBeDefined()
      expect(pullCall![1]).toContain('--rebase')

      expect(mockSetOutput).toHaveBeenCalledWith('committed', 'true')
    })

    test('fails after max retries', async () => {
      mockInputs({
        ...defaultInputs,
        force_push: 'false',
        retry_on_conflict: 'true',
        max_retries: '2'
      })

      mockExecFn.mockImplementation(
        async (cmd: string, args?: string[], opts?: any): Promise<number> => {
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--quiet'
          ) {
            return 1
          }
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--name-only'
          ) {
            return 0
          }
          if (cmd === 'git' && args?.[0] === 'rev-parse') {
            opts?.listeners?.stdout?.(Buffer.from('sha1\n'))
            return 0
          }
          if (cmd === 'git' && args?.[0] === 'push') {
            return 1 // Always fail
          }
          return 0
        }
      )

      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('Push failed after 2 attempts')
      )
    })

    test('does not retry when force_push is true', async () => {
      mockInputs({
        ...defaultInputs,
        force_push: 'true',
        retry_on_conflict: 'true'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      // Normal push (no ignoreReturnCode)
      const pushCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'push'
      )
      expect(pushCall).toBeDefined()
      // Should not have ignoreReturnCode (normal push)
      expect(pushCall![2]).toBeUndefined()
    })
  })

  // ---------- Job summary ----------

  describe('job summary', () => {
    test('generates summary after successful commit', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      mockInputs(defaultInputs)
      mockExecDefault({
        hasChanges: true,
        commitSha: 'sha1',
        changedFiles: 'file.txt\n'
      })
      await run()

      expect(mockSummary.addHeading).toHaveBeenCalledWith('Commit Summary')
      expect(mockSummary.addTable).toHaveBeenCalled()
      expect(mockSummary.write).toHaveBeenCalled()
    })

    test('includes changed files in summary', async () => {
      mockInputs(defaultInputs)
      mockExecDefault({
        hasChanges: true,
        commitSha: 'sha1',
        changedFiles: 'a.txt\nb.txt\n'
      })
      await run()

      expect(mockSummary.addHeading).toHaveBeenCalledWith('Changed Files', 3)
      expect(mockSummary.addList).toHaveBeenCalledWith(['a.txt', 'b.txt'])
    })

    test('does not crash if summary fails', async () => {
      mockInputs(defaultInputs)
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      mockSummary.addHeading.mockImplementation(() => {
        throw new Error('summary error')
      })
      await run()

      // Should still succeed
      expect(mockSetFailed).not.toHaveBeenCalled()
      expect(mockSetOutput).toHaveBeenCalledWith('committed', 'true')
    })
  })

  // ---------- Working directory ----------

  describe('working directory', () => {
    test('errors when work_dir does not exist', async () => {
      mockInputs({...defaultInputs, work_dir: '/nonexistent/path'})
      mockExecDefault()
      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('Working directory does not exist')
      )
    })
  })

  // ---------- Branch resolution in run ----------

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

    test('falls back to main for unknown ref format', async () => {
      process.env.GITHUB_REF = 'refs/pull/99/merge'
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

    test('handles empty commit SHA', async () => {
      mockInputs({...defaultInputs, skip_if_no_changes: 'false'})
      mockExecFn.mockImplementation(
        async (cmd: string, args?: string[]): Promise<number> => {
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--quiet'
          ) {
            return 0
          }
          // rev-parse returns nothing
          return 0
        }
      )
      await run()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to get commit SHA')
      )
    })

    test('cleans up timestamp env vars even if commit fails', async () => {
      mockInputs({
        ...defaultInputs,
        commit_timestamp: '2024-01-01T00:00:00Z'
      })
      mockExecFn.mockImplementation(
        async (cmd: string, args?: string[]): Promise<number> => {
          if (
            cmd === 'git' &&
            args?.[0] === 'diff' &&
            args?.[2] === '--quiet'
          ) {
            return 1
          }
          if (cmd === 'git' && args?.[0] === 'commit') {
            throw new Error('commit failed')
          }
          return 0
        }
      )
      await run()

      // Even though commit threw, env vars should be cleaned up
      expect(process.env.GIT_AUTHOR_DATE).toBeUndefined()
      expect(process.env.GIT_COMMITTER_DATE).toBeUndefined()
      expect(mockSetFailed).toHaveBeenCalled()
    })
  })

  // ---------- Template variables ----------

  describe('template variables', () => {
    test('expands {{date}} in commit message', async () => {
      mockInputs({
        ...defaultInputs,
        commit_message: 'build: deploy on {{date}}'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msgIndex = (commitCall![1] as string[]).indexOf('-m') + 1
      const message = commitCall![1][msgIndex] as string
      // Should contain a date like 2026-03-31, not {{date}}
      expect(message).not.toContain('{{date}}')
      expect(message).toMatch(/build: deploy on \d{4}-\d{2}-\d{2}/)
    })

    test('expands {{sha:short}} in commit message', async () => {
      mockInputs({
        ...defaultInputs,
        commit_message: 'build: from {{sha:short}}'
      })
      // mockExecDefault returns 'abc123def456' for all rev-parse calls
      // The initial rev-parse (for template vars) gets this SHA
      mockExecDefault({hasChanges: true, commitSha: 'abc123def456'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msgIndex = (commitCall![1] as string[]).indexOf('-m') + 1
      const message = commitCall![1][msgIndex] as string
      expect(message).not.toContain('{{sha:short}}')
      // sha:short is first 7 chars of the initial HEAD SHA
      expect(message).toBe('build: from abc123d')
    })

    test('expands {{branch}} in commit message', async () => {
      process.env.GITHUB_REF = 'refs/heads/develop'
      mockInputs({
        ...defaultInputs,
        commit_message: 'deploy to {{branch}}'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msgIndex = (commitCall![1] as string[]).indexOf('-m') + 1
      expect(commitCall![1][msgIndex]).toBe('deploy to develop')
    })

    test('expands {{actor}} and {{repository}} from env', async () => {
      process.env.GITHUB_ACTOR = 'bot-user'
      process.env.GITHUB_REPOSITORY = 'org/repo'
      mockInputs({
        ...defaultInputs,
        commit_message: '{{actor}} pushed to {{repository}}'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msgIndex = (commitCall![1] as string[]).indexOf('-m') + 1
      expect(commitCall![1][msgIndex]).toBe('bot-user pushed to org/repo')
    })

    test('expands template vars in commit body', async () => {
      process.env.GITHUB_RUN_ID = '12345'
      mockInputs({
        ...defaultInputs,
        commit_body: 'Run: {{run_id}}'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msgIndex = (commitCall![1] as string[]).indexOf('-m') + 1
      const message = commitCall![1][msgIndex] as string
      expect(message).toContain('Run: 12345')
    })

    test('preserves unknown template vars', async () => {
      mockInputs({
        ...defaultInputs,
        commit_message: 'keep {{unknown_var}} as-is'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msgIndex = (commitCall![1] as string[]).indexOf('-m') + 1
      expect(commitCall![1][msgIndex]).toBe('keep {{unknown_var}} as-is')
    })

    test('works with messages without template vars', async () => {
      mockInputs({
        ...defaultInputs,
        commit_message: 'plain message'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const commitCall = mockExecFn.mock.calls.find(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msgIndex = (commitCall![1] as string[]).indexOf('-m') + 1
      expect(commitCall![1][msgIndex]).toBe('plain message')
    })

    test('expands template vars in multi-commit messages', async () => {
      process.env.GITHUB_REF = 'refs/heads/main'
      mockInputs({
        ...defaultInputs,
        commits: JSON.stringify([
          {message: 'deploy {{branch}} part 1'},
          {message: 'deploy {{branch}} part 2'}
        ])
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      await run()

      const commitCalls = mockExecFn.mock.calls.filter(
        (c: any[]) => c[0] === 'git' && c[1]?.[0] === 'commit'
      )
      const msg1Idx = (commitCalls[0][1] as string[]).indexOf('-m') + 1
      const msg2Idx = (commitCalls[1][1] as string[]).indexOf('-m') + 1
      expect(commitCalls[0][1][msg1Idx]).toBe('deploy main part 1')
      expect(commitCalls[1][1][msg2Idx]).toBe('deploy main part 2')
    })
  })

  // ---------- PR labels and draft ----------

  describe('PR labels and draft', () => {
    test('creates draft PR when pr_draft=true', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_API_URL = 'https://api.github.com'
      mockInputs({
        ...defaultInputs,
        create_pr: 'true',
        token: 'ghp_test',
        pr_base_branch: 'main',
        pr_draft: 'true',
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

      const fetchCall = (global.fetch as jest.Mock).mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/pulls')
      )
      const body = JSON.parse(fetchCall[1].body as string)
      expect(body.draft).toBe(true)
    })

    test('does not set draft field when pr_draft=false', async () => {
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

      const fetchCall = (global.fetch as jest.Mock).mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/pulls')
      )
      const body = JSON.parse(fetchCall[1].body as string)
      expect(body.draft).toBeUndefined()
    })

    test('adds labels to PR after creation', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_API_URL = 'https://api.github.com'
      mockInputs({
        ...defaultInputs,
        create_pr: 'true',
        token: 'ghp_test',
        pr_base_branch: 'main',
        pr_labels: 'bug, enhancement, automated',
        branch: 'feature'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      ;(global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            html_url: 'https://github.com/owner/repo/pull/5',
            number: 5
          })
        })
        .mockResolvedValueOnce({ok: true, json: async () => []})
      await run()

      // Second fetch call should be to add labels
      const labelCall = (global.fetch as jest.Mock).mock.calls.find(
        (c: any[]) =>
          typeof c[0] === 'string' && c[0].includes('/issues/5/labels')
      )
      expect(labelCall).toBeDefined()
      const body = JSON.parse(labelCall[1].body as string)
      expect(body.labels).toEqual(['bug', 'enhancement', 'automated'])
    })

    test('warns but does not fail if label addition fails', async () => {
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      process.env.GITHUB_API_URL = 'https://api.github.com'
      mockInputs({
        ...defaultInputs,
        create_pr: 'true',
        token: 'ghp_test',
        pr_base_branch: 'main',
        pr_labels: 'nonexistent-label',
        branch: 'feature'
      })
      mockExecDefault({hasChanges: true, commitSha: 'sha1'})
      ;(global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            html_url: 'https://github.com/owner/repo/pull/1',
            number: 1
          })
        })
        .mockResolvedValueOnce({
          ok: false,
          statusText: 'Not Found'
        })
      await run()

      // Should warn but not fail
      expect(mockSetFailed).not.toHaveBeenCalled()
      expect(mockSetOutput).toHaveBeenCalledWith('committed', 'true')
    })

    test('does not call labels API when pr_labels is empty', async () => {
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

      // Only one fetch call (PR creation), no labels call
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })
  })

  // ---------- Rebase conflict handling ----------

  describe('rebase conflict handling', () => {
    test('aborts rebase and fails on conflict during retry', async () => {
      mockInputs({
        ...defaultInputs,
        force_push: 'false',
        retry_on_conflict: 'true',
        max_retries: '3'
      })

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
            opts?.listeners?.stdout?.(Buffer.from('sha1\n'))
            return 0
          }
          if (cmd === 'git' && args?.[0] === 'push') {
            return 1 // Push always fails
          }
          if (cmd === 'git' && args?.[0] === 'pull') {
            return 1 // Rebase conflict
          }
          return 0
        }
      )
      await run()

      // Should have called rebase --abort
      const abortCall = mockExecFn.mock.calls.find(
        (c: any[]) =>
          c[0] === 'git' && c[1]?.[0] === 'rebase' && c[1]?.[1] === '--abort'
      )
      expect(abortCall).toBeDefined()

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('rebase conflict')
      )
    })
  })
})

// ==================== Unit tests: expandTemplateVars ====================

describe('expandTemplateVars', () => {
  test('expands known variables', () => {
    const vars = {date: '2024-01-01', branch: 'main', sha: 'abc123'}
    expect(expandTemplateVars('deploy {{branch}} on {{date}}', vars)).toBe(
      'deploy main on 2024-01-01'
    )
  })

  test('preserves unknown variables', () => {
    expect(expandTemplateVars('{{unknown}}', {})).toBe('{{unknown}}')
  })

  test('handles colon-separated keys', () => {
    const vars = {'sha:short': 'abc1234'}
    expect(expandTemplateVars('sha: {{sha:short}}', vars)).toBe('sha: abc1234')
  })

  test('handles multiple occurrences', () => {
    const vars = {branch: 'main'}
    expect(expandTemplateVars('{{branch}} and {{branch}}', vars)).toBe(
      'main and main'
    )
  })

  test('returns string as-is when no template vars present', () => {
    expect(expandTemplateVars('no vars here', {})).toBe('no vars here')
  })

  test('handles empty string', () => {
    expect(expandTemplateVars('', {})).toBe('')
  })
})

// ==================== Unit tests: buildTemplateVars ====================

describe('buildTemplateVars', () => {
  test('returns all expected keys', () => {
    const vars = buildTemplateVars('main', 'abc123def456')
    expect(vars).toHaveProperty('date')
    expect(vars).toHaveProperty('datetime')
    expect(vars).toHaveProperty('sha', 'abc123def456')
    expect(vars).toHaveProperty('sha:short', 'abc123d')
    expect(vars).toHaveProperty('branch', 'main')
    expect(vars).toHaveProperty('run_id')
    expect(vars).toHaveProperty('run_number')
    expect(vars).toHaveProperty('actor')
    expect(vars).toHaveProperty('repository')
  })

  test('date is in YYYY-MM-DD format', () => {
    const vars = buildTemplateVars('main', 'sha')
    expect(vars.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('datetime is ISO format', () => {
    const vars = buildTemplateVars('main', 'sha')
    expect(vars.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('reads env vars', () => {
    process.env.GITHUB_RUN_ID = '999'
    process.env.GITHUB_RUN_NUMBER = '42'
    process.env.GITHUB_ACTOR = 'testbot'
    process.env.GITHUB_REPOSITORY = 'org/repo'
    const vars = buildTemplateVars('main', 'sha')
    expect(vars.run_id).toBe('999')
    expect(vars.run_number).toBe('42')
    expect(vars.actor).toBe('testbot')
    expect(vars.repository).toBe('org/repo')
  })
})

// ==================== Unit tests: getInputs - new fields ====================

describe('getInputs - PR options', () => {
  const mockInputsFn = (inputs: Record<string, string>): void => {
    mockGetInput.mockImplementation((name: string) => inputs[name] || '')
  }

  test('parses pr_labels as comma-separated list', () => {
    mockInputsFn({
      commit_message: 'test',
      pr_labels: 'bug, enhancement, automated'
    })
    const inputs = getInputs()
    expect(inputs.prLabels).toEqual(['bug', 'enhancement', 'automated'])
  })

  test('handles empty pr_labels', () => {
    mockInputsFn({commit_message: 'test'})
    expect(getInputs().prLabels).toEqual([])
  })

  test('handles single pr_label', () => {
    mockInputsFn({commit_message: 'test', pr_labels: 'bug'})
    expect(getInputs().prLabels).toEqual(['bug'])
  })

  test('strips whitespace from pr_labels', () => {
    mockInputsFn({commit_message: 'test', pr_labels: ' bug , fix '})
    expect(getInputs().prLabels).toEqual(['bug', 'fix'])
  })

  test('filters empty labels from trailing comma', () => {
    mockInputsFn({commit_message: 'test', pr_labels: 'bug,,fix,'})
    expect(getInputs().prLabels).toEqual(['bug', 'fix'])
  })

  test('parses pr_draft', () => {
    mockInputsFn({commit_message: 'test', pr_draft: 'true'})
    expect(getInputs().prDraft).toBe(true)
  })

  test('pr_draft defaults to false', () => {
    mockInputsFn({commit_message: 'test'})
    expect(getInputs().prDraft).toBe(false)
  })
})
