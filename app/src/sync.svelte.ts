// Saving to GitHub: what the person does goes into commits on the branch of the session, in the right moment, and the
// session is submitted, followed (accepted, given back, closed) and aligned with what GitHub says. The workspace holds
// the state; this class decides when and what is sent, and how the answers are taken over.

import { validateObjectYaml } from '@tamandua/core'
import { SignedOut } from './api.js'
import { StaleBranch, type Backend, type Removed, type RemoteErfassung, type SaveResult, type SessionRef } from './backend.js'
import type { ChatMessage, Login, ObjectRecord, Session } from './workspace.svelte.js'

const APP_DELAY = 1_000
const TYPING_DELAY = 30_000
const SYNC_RETRY = 60_000
/** A save shows for at least this long, so that it can be seen that something happened. */
const MIN_SAVING = 500

/** What the sync needs from the workspace: its state, and the few ways to change it. */
export interface Host {
  readonly backend: Backend
  readonly login: Login
  readonly objects: ObjectRecord[]
  readonly sessions: Session[]
  readonly current: Session | undefined
  readonly shown: ObjectRecord[]
  readonly unsaved: ObjectRecord[]
  ref(session: Session): SessionRef
  refer(object: ObjectRecord): string
  touchObject(id: string): void
  touchSession(id: string): void
  schedule(): void
  say(role: ChatMessage['role'], text: string): ChatMessage
  add(name: string): Session
  ensureOpen(show: boolean): void
  mergeRemote(session: Session, remote: { id: string; status?: 'added' | 'modified' | 'removed'; text?: string }[], filesBase?: string, complete?: boolean): { held: string[] }
}

export class Sync {
  /** Saving to GitHub: `failed` is shown to the person, with the reason in `syncError`. */
  syncState = $state<'idle' | 'saving' | 'failed'>('idle')
  syncError = $state<string>()
  /** The sessions and objects a save is running for right now, and the sessions whose last save failed. */
  savingSessions = $state<string[]>([])
  savingObjects = $state<string[]>([])
  failedSessions = $state<string[]>([])
  /** True while the pull request is being opened. */
  submitting = $state(false)
  /** True while a save runs. */
  running = false

  #again = false
  #appTimer: ReturnType<typeof setTimeout> | undefined
  #typingTimer: ReturnType<typeof setTimeout> | undefined
  host: Host

  constructor(host: Host) {
    this.host = host
  }

  #typingPending = false

  stopTimers() {
    clearTimeout(this.#appTimer)
    clearTimeout(this.#typingTimer)
    this.#typingPending = false
  }

  /**
   * The person turns to something else (another object, another session, another window): what was typed so far
   * is saved now and not after the quiet half minute.
   */
  leave() {
    if (this.#typingPending) void this.sync()
  }

  /** The app changed something: save in a second (the changes of one answer go into one commit). */
  afterApp() {
    if (this.host.login.state !== 'user') return
    clearTimeout(this.#appTimer)
    this.#appTimer = setTimeout(() => void this.sync(), APP_DELAY)
  }

  /** The person typed: save when it has been quiet for a while, or earlier if the app saves anyway. */
  afterTyping(delay = TYPING_DELAY) {
    if (this.host.login.state !== 'user') return
    clearTimeout(this.#typingTimer)
    this.#typingPending = delay === TYPING_DELAY
    this.#typingTimer = setTimeout(() => void this.sync(), delay)
  }


  /** Saves every open session: its changed objects in one commit on its branch, and removes what was deleted. Returns whether everything is saved. */
  async sync(): Promise<boolean> {
    this.stopTimers()
    if (this.host.login.state !== 'user') return false
    if (this.running) {
      this.#again = true
      return false
    }
    const pending = (session: Session) => this.host.objects.filter((o) => o.sessionId === session.id && o.text !== o.synced).map((object) => ({ object, text: object.text }))
    const work = this.host.sessions.filter((s) => s.state !== 'merged' && (pending(s).length > 0 || s.deleted.length > 0))
    // A session with nothing left to save has nothing that failed (e.g. the change was undone).
    this.failedSessions = this.failedSessions.filter((id) => work.some((session) => session.id === id))
    if (work.length === 0) {
      if (this.syncState === 'failed') this.syncState = 'idle'
      this.syncError = undefined
      return true
    }

    this.running = true
    this.syncState = 'saving'
    let ok = false
    let failure: Error | undefined
    let signedOut = false
    for (const session of work) {
      const started = Date.now()
      let todo: { object: ObjectRecord; text: string }[] = []
      let deleted: Removed[] = []
      this.savingSessions.push(session.id)
      try {
        // First what happened on the branch meanwhile (somebody else's changes, also those made on GitHub), so that nothing is
        // overwritten; the save names the commit it was made from, and if the branch moved on in between, it is looked at again.
        let result: SaveResult | undefined
        for (let attempt = 0; ; attempt++) {
          let seenHead: string | undefined
          let held: string[] = []
          if (session.pull) {
            const seen = await this.host.backend.review(session.pull, attempt > 0 ? undefined : session.head)
            if (seen.pull.merged) {
              // Accepted meanwhile: what is still only here goes into a new session, nothing is written to the finished one.
              this.#markMerged(session)
              break
            }
            if (!seen.unchanged) held = this.host.mergeRemote(session, seen.objects, seen.files, seen.head !== session.head).held
            seenHead = seen.head
            if (held.length === 0) session.head = seen.head
          }
          todo = pending(session).filter(({ object }) => !held.includes(object.id))
          deleted = [...session.deleted]
          if (todo.length === 0 && deleted.length === 0) break
          try {
            result = await this.host.backend.save(this.host.ref(session), todo.map(({ object, text }) => ({ id: object.id, text, change: object.synced === undefined ? ('new' as const) : ('changed' as const) })), deleted, seenHead)
          } catch (error) {
            if (error instanceof StaleBranch && attempt < 2) continue
            throw error
          }
          if (held.length === 0 && result.head) session.head = result.head
          break
        }
        this.savingObjects.push(...todo.map(({ object }) => object.id))
        if (!result) continue
        const pull = result.pull
        for (const { object, text } of todo) {
          object.synced = text
          this.host.touchObject(object.id)
        }
        session.deleted = session.deleted.filter((entry) => !deleted.some((d) => d.id === entry.id))
        if (pull) {
          session.pull = pull.number
          session.url = pull.url
        }
        this.host.touchSession(session.id)
        this.failedSessions = this.failedSessions.filter((id) => id !== session.id)
      } catch (error) {
        if (error instanceof SignedOut) {
          signedOut = true
          break
        }
        failure ??= error as Error
        if (!this.failedSessions.includes(session.id)) this.failedSessions.push(session.id)
      } finally {
        // Even a quick save shows for a moment, so that it can be seen that something happened.
        const ids = todo.map(({ object }) => object.id)
        setTimeout(() => {
          const out = (list: string[], id: string) => {
            const at = list.indexOf(id)
            if (at >= 0) list.splice(at, 1)
          }
          out(this.savingSessions, session.id)
          for (const id of ids) out(this.savingObjects, id)
        }, Math.max(0, MIN_SAVING - (Date.now() - started)))
      }
    }
    this.host.schedule()
    if (signedOut) {
      this.syncState = 'idle'
    } else if (failure) {
      this.syncState = 'failed'
      this.syncError = failure.message
      this.afterTyping(SYNC_RETRY)
    } else {
      this.syncState = 'idle'
      this.syncError = undefined
      ok = true
    }
    this.running = false
    if (this.#again) {
      this.#again = false
      this.afterApp()
    }
    return ok && this.host.unsaved.length === 0 && !this.host.sessions.some((s) => s.state !== 'merged' && s.deleted.length > 0)
  }

  /** Saves what is open, then submits the shown session. Tells the person in the chat what came of it. */
  async submit() {
    const session = this.host.current
    if (this.submitting || this.host.login.state !== 'user' || !session || session.state !== 'open') return
    const objects = this.host.shown
    if (objects.length === 0) return
    this.submitting = true
    try {
      const open = objects.filter((o) => validateObjectYaml(o.text).length > 0)
      if (open.length > 0) {
        const list = open.slice(0, 3).map((o) => this.host.refer(o)).join(', ') + (open.length > 3 ? ', …' : '')
        this.host.say('status', `Wir können erst einreichen, wenn alle Objekte vollständig sind. Noch offen: ${list}.`)
        return
      }
      // Not syncing in the middle of an edit: wait for a running save, then save the rest.
      while (this.running) await new Promise((resolve) => setTimeout(resolve, 100))
      if (!(await this.sync())) {
        this.host.say('status', `Das Einreichen ging nicht, weil das Speichern nicht geklappt hat${this.syncError ? `: ${this.syncError}` : '.'}`)
        return
      }
      if (session.state !== 'open') return // it turned out to be submitted already
      const pull = await this.host.backend.submit(this.host.ref(session))
      session.state = 'submitted'
      session.pull = pull.number
      session.url = pull.url
      this.host.touchSession(session.id)
      this.host.schedule()
      const n = objects.length
      this.host.say('assistant', `Ich habe die Erfassung „${session.name}“ mit ${n === 1 ? 'einem Objekt' : `${n} Objekten`} eingereicht. Sie wird jetzt geprüft. Du kannst in einer anderen Erfassung weitermachen.`)
      this.host.ensureOpen(true)
    } catch (error) {
      if (!(error instanceof SignedOut)) this.host.say('status', `Das Einreichen ging nicht: ${(error as Error).message}`)
    } finally {
      this.submitting = false
    }
  }

  /**
   * A session was accepted: it is final. What is still only here (changed or new objects that were not saved before it was
   * accepted) would be lost silently, so it goes into a new session of its own, with a note in the chat.
   */
  #markMerged(session: Session) {
    if (session.state === 'merged') return
    const rest = this.host.objects.filter((o) => o.sessionId === session.id && o.text !== o.synced)
    session.state = 'merged'
    session.deleted = []
    this.host.touchSession(session.id)
    if (rest.length > 0) {
      const follow = this.host.add(`${session.name} (Nachtrag)`)
      for (const object of rest) {
        object.sessionId = follow.id
        object.synced = undefined
        this.host.touchObject(object.id)
      }
      this.host.say('status', `Die Erfassung „${session.name}“ wurde übernommen, während ${rest.length === 1 ? 'ein Objekt noch ungespeicherte Änderungen hatte' : `${rest.length} Objekte noch ungespeicherte Änderungen hatten`}. Sie liegen jetzt in der neuen Erfassung „${follow.name}“.`)
    }
    this.host.schedule()
  }

  /**
   * Looks at the branch of a session and takes over what is new there (nothing is written). Called when the session is shown or
   * when GitHub tells that it changed. Does nothing while a save runs: that looks at the branch itself.
   */
  async pullSession(session: Session): Promise<void> {
    if (this.host.login.state !== 'user' || !session.pull || session.state === 'merged' || this.running) return
    try {
      const seen = await this.host.backend.review(session.pull, session.head)
      if (this.running || seen.unchanged || !this.host.sessions.includes(session)) return
      if (seen.pull.merged) return this.#markMerged(session)
      const { held } = this.host.mergeRemote(session, seen.objects, seen.files, seen.head !== session.head)
      if (held.length === 0) session.head = seen.head
      this.host.touchSession(session.id)
    } catch {
      // no connection or signed out: the next look (or the next save) does it
    }
  }

  /** Brings everything of the session to GitHub and takes over what is new there; true if nothing is left to be saved (before accepting it, say). */
  async settle(session: Session): Promise<boolean> {
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 100))
    const saved = await this.sync()
    return saved && !this.host.objects.some((o) => o.sessionId === session.id && o.text !== o.synced)
  }

  /** Takes over how GitHub sees the sessions that are here (somebody else may have submitted, returned or accepted one). */
  align(list: RemoteErfassung[]) {
    for (const session of this.host.sessions) {
      const remote = session.pull === undefined ? undefined : list.find((e) => e.number === session.pull)
      if (!remote) continue
      const state: Session['state'] = remote.state === 'merged' ? 'merged' : remote.closed ? 'open' : remote.state === 'submitted' ? 'submitted' : 'open'
      if (state === session.state) continue
      if (state === 'merged') {
        this.#markMerged(session)
        continue
      }
      session.state = state
      if (remote.closed && remote.state !== 'merged') {
        session.pull = undefined
        session.url = undefined
      }
      this.host.touchSession(session.id)
    }
    this.host.schedule()
  }

  /** Looks at the pull requests that wait for review: an accepted session is final, a closed one is open again. */
  async checkPulls() {
    if (this.host.login.state !== 'user') return
    for (const session of this.host.sessions.filter((s) => s.state === 'submitted' && s.pull)) {
      try {
        const pull = await this.host.backend.pull(session.pull as number)
        if (pull.state === 'open') {
          if (pull.draft) {
            // Given back by a reviewer: it is a draft again, the session goes on and can be submitted anew.
            session.state = 'open'
            this.host.touchSession(session.id)
            this.host.schedule()
            this.host.say('status', `Die Erfassung „${session.name}“ wurde zurückgegeben. Du kannst sie überarbeiten und erneut einreichen.${session.url ? ' Anmerkungen stehen auf GitHub.' : ''}`)
          }
          continue
        }
        const n = this.host.objects.filter((o) => o.sessionId === session.id).length
        if (pull.merged) {
          this.#markMerged(session)
          this.host.say('assistant', `Die Erfassung „${session.name}“ wurde geprüft und übernommen (${n === 1 ? 'ein Objekt' : `${n} Objekte`}). Danke!`)
        } else {
          // Closed without being accepted: the branch is still there, the session can be revised and submitted again.
          session.state = 'open'
          session.pull = undefined
          session.url = undefined
          this.host.say('status', `Die Einreichung der Erfassung „${session.name}“ wurde nicht übernommen. Du kannst sie überarbeiten und erneut einreichen.`)
        }
        this.host.touchSession(session.id)
        this.host.schedule()
      } catch {
        return // no connection or signed out: next time
      }
    }
  }
}
