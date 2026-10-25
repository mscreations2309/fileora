import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync, CryptoDigestAlgorithm, digest, getRandomBytes } from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { FileoraStorage } from 'fileora-storage';
import { create } from 'zustand';

import { FileoraError } from '@/core/errors/FileoraError';
import { fromBase64, fromRecoveryCode, toBase64, toRecoveryCode, utf8 } from '@/core/security/bytes';

/**
 * Private Vault key management.
 *
 * A random 256-bit vault key encrypts everything. It is never stored in plaintext. It is kept:
 *  1. In SecureStore with `requireAuthentication` (Android Keystore / iOS Keychain): released only after
 *     biometric or device-credential authentication. The key is not derived from biometrics.
 *  2. Wrapped (AES-GCM) with a key derived from the vault passcode via PBKDF2-HMAC-SHA256.
 *  3. Wrapped with a key derived from a one-time recovery key shown at setup.
 * Losing the passcode, biometrics and the recovery key means the vault cannot be decrypted by anyone.
 */

const META_KEY = 'fileora.vault.meta.v1';
const BIOMETRIC_KEY = 'fileora.vault.key.biometric.v1';
const PASSCODE_ITERATIONS = 310_000;
const RECOVERY_ITERATIONS = 10_000;
const CHECK_PLAINTEXT = 'fileora-vault-v1';

type VaultMeta = {
  version: 1;
  createdAt: number;
  passcode: { salt: string; iterations: number; wrapped: string } | null;
  recovery: { salt: string; iterations: number; wrapped: string };
  /** AES-GCM(vaultKey, CHECK_PLAINTEXT): verifies a candidate key without touching files. */
  check: string;
  biometric: boolean;
};

export type VaultStatus = 'loading' | 'notSetUp' | 'locked' | 'unlocked';

type VaultState = {
  status: VaultStatus;
  key: AESEncryptionKey | null;
  biometricEnabled: boolean;
  passcodeEnabled: boolean;
  lastActivity: number;
};

export const useVault = create<VaultState>()(() => ({
  status: 'loading',
  key: null,
  biometricEnabled: false,
  passcodeEnabled: false,
  lastActivity: 0,
}));

async function readMeta(): Promise<VaultMeta | null> {
  const raw = await SecureStore.getItemAsync(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VaultMeta;
  } catch {
    throw new FileoraError('ERR_INTERNAL', 'Vault settings are unreadable');
  }
}

async function writeMeta(meta: VaultMeta): Promise<void> {
  await SecureStore.setItemAsync(META_KEY, JSON.stringify(meta), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

export async function refreshVaultStatus(): Promise<void> {
  const meta = await readMeta();
  const current = useVault.getState();
  useVault.setState({
    status: !meta ? 'notSetUp' : current.key ? 'unlocked' : 'locked',
    biometricEnabled: meta?.biometric ?? false,
    passcodeEnabled: Boolean(meta?.passcode),
  });
}

/** Native PBKDF2 on Android. iOS has no passcode path yet (biometrics/device passcode + recovery key). */
export const passcodeSupported = FileoraStorage !== null;

async function deriveWrappingKey(secret: string, salt: string, iterations: number): Promise<AESEncryptionKey> {
  if (FileoraStorage) {
    const derived = await FileoraStorage.deriveKey(secret, salt, iterations, 32);
    return AESEncryptionKey.import(fromBase64(derived));
  }
  // iOS fallback for the high-entropy recovery key only: SHA-256(salt || key) is sufficient there.
  const hashed = await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array([...fromBase64(salt), ...utf8(secret)]));
  return AESEncryptionKey.import(new Uint8Array(hashed));
}

async function seal(key: AESEncryptionKey, plaintext: Uint8Array, aad: string): Promise<string> {
  const sealed = await aesEncryptAsync(plaintext, key, { additionalData: utf8(aad) });
  return toBase64(await sealed.combined());
}

async function open(key: AESEncryptionKey, combined: string, aad: string): Promise<Uint8Array> {
  return aesDecryptAsync(AESSealedData.fromCombined(fromBase64(combined)), key, { additionalData: utf8(aad) });
}

async function verify(key: AESEncryptionKey, meta: VaultMeta): Promise<boolean> {
  try {
    const plain = await open(key, meta.check, 'check');
    return new TextDecoder().decode(plain) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

export async function biometricsAvailable(): Promise<boolean> {
  return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
}

/**
 * Creates the vault. Returns the recovery key, which must be shown to the user exactly once.
 * The passcode is required where supported so there is always a non-biometric way in.
 */
export async function setUpVault(options: { passcode: string | null; useBiometrics: boolean }): Promise<string> {
  if (await readMeta()) throw new FileoraError('ERR_ALREADY_EXISTS', 'The vault is already set up');
  const vaultKeyBytes = getRandomBytes(32);
  const vaultKey = await AESEncryptionKey.import(vaultKeyBytes);
  const recoveryBytes = getRandomBytes(20);
  const recoveryCode = toRecoveryCode(recoveryBytes);
  const recoverySalt = toBase64(getRandomBytes(16));
  const recoveryKey = await deriveWrappingKey(recoveryCode.replace(/-/g, ''), recoverySalt, RECOVERY_ITERATIONS);

  let passcode: VaultMeta['passcode'] = null;
  if (options.passcode) {
    const salt = toBase64(getRandomBytes(16));
    const passcodeKey = await deriveWrappingKey(options.passcode, salt, PASSCODE_ITERATIONS);
    passcode = { salt, iterations: PASSCODE_ITERATIONS, wrapped: await seal(passcodeKey, vaultKeyBytes, 'passcode') };
  }

  let biometric = false;
  if (options.useBiometrics) {
    await SecureStore.setItemAsync(BIOMETRIC_KEY, toBase64(vaultKeyBytes), {
      requireAuthentication: true,
      authenticationPrompt: 'Unlock Private Vault',
      keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    });
    biometric = true;
  }

  await writeMeta({
    version: 1,
    createdAt: Date.now(),
    passcode,
    recovery: { salt: recoverySalt, iterations: RECOVERY_ITERATIONS, wrapped: await seal(recoveryKey, vaultKeyBytes, 'recovery') },
    check: await seal(vaultKey, utf8(CHECK_PLAINTEXT), 'check'),
    biometric,
  });
  vaultKeyBytes.fill(0);
  recoveryBytes.fill(0);
  useVault.setState({ status: 'unlocked', key: vaultKey, biometricEnabled: biometric, passcodeEnabled: Boolean(passcode), lastActivity: Date.now() });
  return recoveryCode;
}

async function finishUnlock(keyBytes: Uint8Array, meta: VaultMeta): Promise<void> {
  const key = await AESEncryptionKey.import(keyBytes);
  keyBytes.fill(0);
  if (!(await verify(key, meta))) throw new FileoraError('ERR_ACCESS_DENIED', 'That did not unlock the vault');
  useVault.setState({ status: 'unlocked', key, lastActivity: Date.now() });
}

export async function unlockWithBiometrics(): Promise<void> {
  const meta = await readMeta();
  if (!meta?.biometric) throw new FileoraError('ERR_UNSUPPORTED', 'Biometric unlock is not set up');
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(BIOMETRIC_KEY, { requireAuthentication: true, authenticationPrompt: 'Unlock Private Vault' });
  } catch {
    // Enrolling new biometrics invalidates Keystore keys; the passcode or recovery key still work.
    throw new FileoraError('ERR_ACCESS_DENIED', 'Biometric unlock was cancelled or is no longer valid. Use your vault passcode.');
  }
  if (!stored) throw new FileoraError('ERR_ACCESS_DENIED', 'Biometric key is unavailable. Use your vault passcode.');
  await finishUnlock(fromBase64(stored), meta);
}

export async function unlockWithPasscode(passcode: string): Promise<void> {
  const meta = await readMeta();
  if (!meta?.passcode) throw new FileoraError('ERR_UNSUPPORTED', 'No vault passcode is set');
  const wrapping = await deriveWrappingKey(passcode, meta.passcode.salt, meta.passcode.iterations);
  let keyBytes: Uint8Array;
  try {
    keyBytes = await open(wrapping, meta.passcode.wrapped, 'passcode');
  } catch {
    throw new FileoraError('ERR_ACCESS_DENIED', 'Incorrect passcode');
  }
  await finishUnlock(keyBytes, meta);
}

export async function unlockWithRecoveryKey(code: string): Promise<void> {
  const meta = await readMeta();
  if (!meta) throw new FileoraError('ERR_NOT_FOUND', 'The vault is not set up');
  const bytes = fromRecoveryCode(code);
  if (!bytes || bytes.length < 20) throw new FileoraError('ERR_ACCESS_DENIED', 'That is not a valid recovery key');
  const normalized = toRecoveryCode(bytes.subarray(0, 20)).replace(/-/g, '');
  const wrapping = await deriveWrappingKey(normalized, meta.recovery.salt, meta.recovery.iterations);
  let keyBytes: Uint8Array;
  try {
    keyBytes = await open(wrapping, meta.recovery.wrapped, 'recovery');
  } catch {
    throw new FileoraError('ERR_ACCESS_DENIED', 'Incorrect recovery key');
  }
  await finishUnlock(keyBytes, meta);
}

/** Recovery-key envelope for encrypted backups: lets a backup be opened on a new device. */
export async function recoveryEnvelope(): Promise<{ salt: string; iterations: number; wrapped: string; check: string }> {
  const meta = await readMeta();
  if (!meta) throw new FileoraError('ERR_NOT_FOUND', 'The vault is not set up');
  return { ...meta.recovery, check: meta.check };
}

/** Opens a backup's key envelope with its recovery key. */
export async function keyFromEnvelope(envelope: { salt: string; iterations: number; wrapped: string; check: string }, code: string): Promise<AESEncryptionKey> {
  const bytes = fromRecoveryCode(code);
  if (!bytes || bytes.length < 20) throw new FileoraError('ERR_ACCESS_DENIED', 'That is not a valid recovery key');
  const wrapping = await deriveWrappingKey(toRecoveryCode(bytes.subarray(0, 20)).replace(/-/g, ''), envelope.salt, envelope.iterations);
  let keyBytes: Uint8Array;
  try {
    keyBytes = await open(wrapping, envelope.wrapped, 'recovery');
  } catch {
    throw new FileoraError('ERR_ACCESS_DENIED', 'Incorrect recovery key for this backup');
  }
  const key = await AESEncryptionKey.import(keyBytes);
  keyBytes.fill(0);
  try {
    const plain = await open(key, envelope.check, 'check');
    if (new TextDecoder().decode(plain) !== CHECK_PLAINTEXT) throw new Error('mismatch');
  } catch {
    throw new FileoraError('ERR_VERIFICATION_FAILED', 'This backup is damaged');
  }
  return key;
}

export async function changePasscode(newPasscode: string): Promise<void> {
  const { key } = useVault.getState();
  const meta = await readMeta();
  if (!key || !meta) throw new FileoraError('ERR_ACCESS_DENIED', 'Unlock the vault first');
  const keyBytes = await key.bytes();
  const salt = toBase64(getRandomBytes(16));
  const wrapping = await deriveWrappingKey(newPasscode, salt, PASSCODE_ITERATIONS);
  await writeMeta({ ...meta, passcode: { salt, iterations: PASSCODE_ITERATIONS, wrapped: await seal(wrapping, keyBytes, 'passcode') } });
  keyBytes.fill(0);
  useVault.setState({ passcodeEnabled: true });
}

export async function setBiometricUnlock(enabled: boolean): Promise<void> {
  const { key } = useVault.getState();
  const meta = await readMeta();
  if (!key || !meta) throw new FileoraError('ERR_ACCESS_DENIED', 'Unlock the vault first');
  if (enabled) {
    const keyBytes = await key.bytes();
    await SecureStore.setItemAsync(BIOMETRIC_KEY, toBase64(keyBytes), {
      requireAuthentication: true,
      authenticationPrompt: 'Unlock Private Vault',
      keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    });
    keyBytes.fill(0);
  } else {
    await SecureStore.deleteItemAsync(BIOMETRIC_KEY);
  }
  await writeMeta({ ...meta, biometric: enabled });
  useVault.setState({ biometricEnabled: enabled });
}

export function lockVault(): void {
  useVault.setState({ key: null, status: useVault.getState().status === 'notSetUp' ? 'notSetUp' : 'locked' });
}

export function touchVault(): void {
  if (useVault.getState().key) useVault.setState({ lastActivity: Date.now() });
}

/** Destroys the keys. Encrypted files become permanently unreadable (crypto-shredding). */
export async function destroyVaultKeys(): Promise<void> {
  await SecureStore.deleteItemAsync(BIOMETRIC_KEY);
  await SecureStore.deleteItemAsync(META_KEY);
  useVault.setState({ status: 'notSetUp', key: null, biometricEnabled: false, passcodeEnabled: false });
}

export function validatePasscode(value: string): string | null {
  if (value.length < 6) return 'Use at least 6 characters.';
  if (/^(\d)\1+$/.test(value) || value === '123456' || value === '654321') return 'Choose something harder to guess.';
  return null;
}
