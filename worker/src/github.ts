// The shared part (sign in, tokens, the GitHub call, the repository's pull requests and commits) is in editors-core; below is what only this editor needs.
import { Repo as CoreRepo } from 'editors-core/worker/repo'

export * from 'editors-core/worker/github'
export type { ChangedFile, Checks, ListedPull, Pull, PullInfo, RawComment, RepoFile } from 'editors-core/worker/repo'

/** The path of an object in the data repository: the only kind of file a session may change. */
export const OBJECT_FILE = /^objects\/[0-9A-HJKMNP-TV-Z]\/[0-9A-HJKMNP-TV-Z]\/([0-9A-HJKMNP-TV-Z]{26})\.yaml$/

/** One person's work on the data repository: their own branch and its pull request. */
export class Repo extends CoreRepo {
  constructor(token: string, repo: string, base: string, fetchFn: typeof fetch) {
    super(token, repo, base, fetchFn, {
      isSubmissionBranch: (branch) => /^erfassung\/[A-Za-z0-9-]+\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch),
      isEntryFile: (path) => OBJECT_FILE.test(path),
      submission: 'Erfassung',
      entries: 'Objekte',
    })
  }
}
