import { initializeApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  getAuth,
  onIdTokenChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
} from 'firebase/auth'
import type { FirebaseConfig, User } from '../shared/types'

let auth: Auth | null = null
let token: string | null = null

/** The Worker verifies this Firebase ID token before returning any data. */
export const accessToken = (): string | null => token

export function initFirebase(config: FirebaseConfig): void {
  if (auth) return
  auth = getAuth(initializeApp(config))
  // Firebase refreshes the ID token hourly; keep the copy we send in step.
  onIdTokenChanged(auth, async (user) => {
    token = user ? await user.getIdToken().catch(() => null) : null
  })
}

function toUser(value: {
  uid: string
  email: string | null
  displayName: string | null
}): User {
  return {
    sub: value.uid,
    email: value.email ?? undefined,
    name: value.displayName || value.email || undefined,
  }
}

/** Resolves the session Firebase restored from the phone's Google account. */
export async function currentUser(): Promise<User | null> {
  if (!auth) return null
  await auth.authStateReady()
  const user = auth.currentUser
  if (!user) {
    token = null
    return null
  }
  token = await user.getIdToken()
  return toUser(user)
}

export async function signInWithGoogle(): Promise<void> {
  if (!auth) throw new Error('Sign-in is not configured on this site yet.')
  const provider = new GoogleAuthProvider()
  // Always show the account picker, so a shared phone is not locked to one.
  provider.setCustomParameters({ prompt: 'select_account' })
  const result = await signInWithPopup(auth, provider)
  token = await result.user.getIdToken()
}

export async function signOut(): Promise<void> {
  token = null
  if (auth) await firebaseSignOut(auth).catch(() => undefined)
}
