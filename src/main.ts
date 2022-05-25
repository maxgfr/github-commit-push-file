import * as core from '@actions/core'
import * as exec from '@actions/exec'

const run = async (): Promise<void> => {
  try {
    const commitName = core.getInput('commit_name', {required: true})

    core.info(`Committing file for this commit : ${commitName}`)

    await exec.exec('git', [
      'config',
      '--global',
      'user.name',
      process.env.GITHUB_ACTOR ?? ''
    ])
    await exec.exec('git', [
      'config',
      '--global',
      'user.email',
      `${process.env.GITHUB_ACTOR}@users.noreply.github.com`
    ])
    await exec.exec('git', ['commit', '-am', commitName, '--no-verify'])
    await exec.exec('git', [
      'push',
      '-f',
      '-u',
      'origin',
      `HEAD:${process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF}`
    ])
    core.info('File has been successfully committed and pushed')
  } catch (e: any) {
    core.setFailed(e.message)
  }
}

run()
