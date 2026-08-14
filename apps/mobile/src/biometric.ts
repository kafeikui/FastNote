import { Capacitor } from '@capacitor/core';
import { AccessControl, NativeBiometric } from '@capgo/capacitor-native-biometric';

/**
 * Fingerprint / biometric unlock support (Android).
 *
 * The master password is stored via the native-biometric plugin. Preferred mode is a
 * hardware-protected Keystore key (`BIOMETRY_CURRENT_SET` / `BIOMETRY_ANY`): every read shows a
 * BiometricPrompt cryptographically bound to that read. Some devices/keystores fail to create
 * biometric-bound keys ("Failed to encrypt credentials: null" observed in the field), so we
 * fall back to plain Keystore-encrypted storage gated by an explicit `verifyIdentity()` prompt
 * — weaker (the prompt is a UI gate, not a cryptographic one) but functional everywhere.
 *
 * localStorage keeps only the per-vault mode flag ('hw' | 'soft'); the password itself never
 * touches JS-visible storage. Enrolling a new fingerprint invalidates hw-mode keys
 * (CURRENT_SET semantics); reads then fail and the app falls back to password unlock.
 */

const FLAG_PREFIX = 'fastnote_bio_unlock_';

type BioMode = 'hw' | 'soft';

const serverFor = (namespace: string) => `fastnote.vault/${namespace || 'default'}`;
const flagKey = (namespace: string) => FLAG_PREFIX + (namespace || 'default');

function storedMode(namespace: string): BioMode | null {
  try {
    const v = localStorage.getItem(flagKey(namespace));
    if (v === 'hw' || v === 'soft') return v;
    // '1' was written by the first release of this feature (hw-only).
    if (v === '1') return 'hw';
    return null;
  } catch {
    return null;
  }
}

function setFlag(namespace: string, mode: BioMode | null): void {
  try {
    if (mode) localStorage.setItem(flagKey(namespace), mode);
    else localStorage.removeItem(flagKey(namespace));
  } catch {
    /* storage unavailable — the toggle just won't persist */
  }
}

export function biometricUnlockEnabled(namespace: string): boolean {
  return storedMode(namespace) !== null;
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

/** Stores the master password, preferring hardware-bound access control and falling back to
 *  verify-gated plain storage. Sets the per-vault flag to the mode that actually worked. */
export async function enableBiometricUnlock(
  namespace: string,
  password: string,
  prompt?: { title?: string; reason?: string },
): Promise<void> {
  const base = { server: serverFor(namespace), username: 'vault', password };
  try {
    await NativeBiometric.setCredentials({ ...base, accessControl: AccessControl.BIOMETRY_CURRENT_SET });
    setFlag(namespace, 'hw');
    console.info('[bio] enrolled with BIOMETRY_CURRENT_SET');
    return;
  } catch (err) {
    console.warn('[bio] BIOMETRY_CURRENT_SET enroll failed, trying BIOMETRY_ANY', err);
  }
  try {
    await NativeBiometric.setCredentials({ ...base, accessControl: AccessControl.BIOMETRY_ANY });
    setFlag(namespace, 'hw');
    console.info('[bio] enrolled with BIOMETRY_ANY');
    return;
  } catch (err) {
    console.warn('[bio] BIOMETRY_ANY enroll failed, falling back to verify-gated storage', err);
  }
  // Soft mode: verify identity up-front so enabling still proves the fingerprint works, then
  // store without biometric-bound access control (Keystore-encrypted at rest).
  await NativeBiometric.verifyIdentity({ title: prompt?.title, reason: prompt?.reason });
  await NativeBiometric.setCredentials(base);
  setFlag(namespace, 'soft');
  console.info('[bio] enrolled with verify-gated storage (soft mode)');
}

/** Removes the stored secret and clears the opt-in flag. */
export async function disableBiometricUnlock(namespace: string): Promise<void> {
  setFlag(namespace, null);
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
  const mode = storedMode(namespace);
  if (!mode) return null;
  try {
    if (mode === 'hw') {
      const creds = await NativeBiometric.getSecureCredentials({
        server: serverFor(namespace),
        title: prompt?.title,
        reason: prompt?.reason,
      });
      return creds.password || null;
    }
    await NativeBiometric.verifyIdentity({ title: prompt?.title, reason: prompt?.reason });
    const creds = await NativeBiometric.getCredentials({ server: serverFor(namespace) });
    return creds.password || null;
  } catch (err) {
    console.warn(`[bio] read failed (mode=${mode})`, err);
    return null;
  }
}
