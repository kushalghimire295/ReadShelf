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

/** Turns Firebase's error codes into something a reader can act on. */
export function describeAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
  switch (code) {
    case 'auth/configuration-not-found':
      return 'Google sign-in is not switched on for this Firebase project yet. In the Firebase console open Authentication, then Sign-in method, and enable Google.'
    case 'auth/operation-not-allowed':
      return 'The Google provider is disabled in the Firebase project.'
    case 'auth/unauthorized-domain':
      return `This address (${window.location.hostname}) is not authorized in the Firebase project. Add it under Authentication → Settings → Authorized domains.`
    case 'auth/popup-blocked':
      return 'The browser blocked the Google window. Allow pop-ups for this site, then try again.'
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'The Google window closed before sign-in finished.'
    case 'auth/network-request-failed':
      return 'Could not reach Google. Check your connection and try again.'
    default:
      return error instanceof Error && error.message
        ? error.message
        : 'Could not reach Google. Please try again.'
  }
}

export async function signOut(): Promise<void> {
  token = null
  if (auth) await firebaseSignOut(auth).catch(() => undefined)
}
