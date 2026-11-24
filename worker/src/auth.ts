// Signing in with GitHub: the core of it is shared (editors-core); this editor names its cookies and tells the browser where its files are.
import { createAuth, type AuthEnv as CoreAuthEnv } from 'editors-core/worker/auth'
import { objectUrl } from './s3.js'
import { s3Config, type UploadEnv } from './upload.js'

export type { Signed } from 'editors-core/worker/auth'
export interface AuthEnv extends CoreAuthEnv, UploadEnv {}

export const { readSession, handleAuth } = createAuth<AuthEnv>({
  cookiePrefix: 'archive_editor',
  // Where the bucket's files can be read from (it is public): the browser shows previews and pictures from there.
  me: (env) => {
    const storage = s3Config(env)
    return { files: storage ? objectUrl(storage, '').origin : undefined }
  },
})
