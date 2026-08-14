import { Capacitor } from '@capacitor/core';
import { AccessControl, NativeBiometric } from '@capgo/capacitor-native-biometric';

/**
 * Fingerprint / biometric unlock support (Android).
 *
 * The master password is stored in the Android Keystore via the native-biometric plugin with
 * `BIOMETRY_CURRENT_SET` access control: the Keystore key is hardware-protected and every read
 * shows a BiometricPrompt cryptographically bound to that read — the password never touches
 * JS-visible storage. Only an opt-in *flag* lives in localStorage (per vault namespace), so the
 * unlock screen knows whether to offer the fingerprint button at all.
 *
 * Enrolling a new fingerprint invalidates the Keystore key (CURRENT_SET semantics); reads then
 * fail and the app silently falls back to password unlock.
 */

const FLAG_PREFIX = 'fastnote_bio_unlock_';

const serverFor = (namespace: string) => `fastnote.vault/${namespace || 'default'}`;

export function biometricUnlockEnabled(namespace: string): boolean {
  try {
    return localStorage.getItem(FLAG_PREFIX + (namespace || 'default')) === '1';
  } catch {
    return false;
  }
}

function setFlag(namespace: string, on: boolean): void {
  try {
    const key = FLAG_PREFIX + (namespace || 'default');
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable — the toggle just won't persist */
  }
}

export async function biometricAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const result = await NativeBiometric.isAvailable();
    return result.isAvailable;
  } catch {
    return false;
  }
}

/** Stores the master password behind a biometric-gated Keystore key and sets the opt-in flag.
 *  Android shows a BiometricPrompt for the store operation itself (CURRENT_SET semantics). */
export async function enableBiometricUnlock(namespace: string, password: string): Promise<void> {
  await NativeBiometric.setCredentials({
    server: serverFor(namespace),
    username: 'vault',
    password,
    accessControl: AccessControl.BIOMETRY_CURRENT_SET,
  });
  setFlag(namespace, true);
}

/** Removes the stored secret and clears the opt-in flag. */
export async function disableBiometricUnlock(namespace: string): Promise<void> {
  setFlag(namespace, false);
  try {
    await NativeBiometric.deleteCredentials({ server: serverFor(namespace) });
  } catch {
    /* nothing stored / keystore unavailable — flag is off either way */
  }
}

/** Prompts the fingerprint dialog and returns the stored master password, or null when the
 *  user cancels, biometrics changed (key invalidated), or nothing is stored. */
export async function readBiometricPassword(
  namespace: string,
  prompt?: { title?: string; reason?: string },
): Promise<string | null> {
  try {
    const creds = await NativeBiometric.getSecureCredentials({
      server: serverFor(namespace),
      title: prompt?.title,
      reason: prompt?.reason,
    });
    return creds.password || null;
  } catch {
    return null;
  }
}
