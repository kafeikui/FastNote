import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes, utf8ToBytes, bytesToUtf8 } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { HKDF_INFO } from '@fastnote/shared';

const ARGON2_MEMORY = 65536;
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 4;
const KEY_LEN = 32;

export interface DerivedKeys {
  masterKey: Uint8Array;
  notesKey: Uint8Array;
  indexKey: Uint8Array;
  passwordVerifier: Uint8Array;
}

export interface EncryptedPayload {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export interface IdentityKeypair {
  identityPrivateKey: Uint8Array;
  identityPublicKey: Uint8Array;
  exchangePrivateKey: Uint8Array;
  exchangePublicKey: Uint8Array;
}

function deriveSubKey(masterKey: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, masterKey, undefined, utf8ToBytes(info), KEY_LEN);
}

export async function deriveKeysFromPassword(
  password: string,
  salt: Uint8Array,
): Promise<DerivedKeys> {
  const masterKey = await deriveMasterKey(password, salt);
  return {
    masterKey,
    notesKey: deriveSubKey(masterKey, HKDF_INFO.notes),
    indexKey: deriveSubKey(masterKey, HKDF_INFO.index),
    passwordVerifier: deriveSubKey(masterKey, 'fastnote-verifier-v1'),
  };
}

async function deriveMasterKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
      iterations: 600_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LEN * 8,
  );
  return new Uint8Array(bits);
}

export function generateIdentityKeypair(): IdentityKeypair {
  const identityPrivateKey = ed25519.utils.randomSecretKey();
  const identityPublicKey = ed25519.getPublicKey(identityPrivateKey);
  const exchangePrivateKey = x25519.utils.randomSecretKey();
  const exchangePublicKey = x25519.getPublicKey(exchangePrivateKey);
  return { identityPrivateKey, identityPublicKey, exchangePrivateKey, exchangePublicKey };
}

export function wrapKey(masterKey: Uint8Array, secret: Uint8Array): EncryptedPayload {
  return encrypt(masterKey, secret);
}

export function unwrapKey(masterKey: Uint8Array, payload: EncryptedPayload): Uint8Array {
  return decrypt(masterKey, payload);
}

export function generateSalt(): Uint8Array {
  return randomBytes(16);
}

export function encrypt(key: Uint8Array, plaintext: Uint8Array): EncryptedPayload {
  const nonce = randomBytes(12);
  const cipher = gcm(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  return { ciphertext, nonce };
}

export function decrypt(key: Uint8Array, payload: EncryptedPayload): Uint8Array {
  const cipher = gcm(key, payload.nonce);
  return cipher.decrypt(payload.ciphertext);
}

export function encryptString(key: Uint8Array, text: string): EncryptedPayload {
  return encrypt(key, utf8ToBytes(text));
}

export function decryptString(key: Uint8Array, payload: EncryptedPayload): string {
  return bytesToUtf8(decrypt(key, payload));
}

export function encryptJson<T>(key: Uint8Array, data: T): EncryptedPayload {
  return encryptString(key, JSON.stringify(data));
}

export function decryptJson<T>(key: Uint8Array, payload: EncryptedPayload): T {
  return JSON.parse(decryptString(key, payload)) as T;
}

export function packEncrypted(payload: EncryptedPayload): string {
  return JSON.stringify({ c: toBase64(payload.ciphertext), n: toBase64(payload.nonce) });
}

export function unpackEncrypted(packed: string): EncryptedPayload {
  const { c, n } = JSON.parse(packed) as { c: string; n: string };
  return { ciphertext: fromBase64(c), nonce: fromBase64(n) };
}

export function encodeWireCiphertext(payload: EncryptedPayload): string {
  return toBase64(new TextEncoder().encode(packEncrypted(payload)));
}

export function decodeWireCiphertext(b64: string): EncryptedPayload {
  const json = new TextDecoder().decode(fromBase64(b64));
  return unpackEncrypted(json);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hashContent(text: string): string {
  const digest = sha256(utf8ToBytes(text));
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const CRYPTO_PARAMS = {
  ARGON2_MEMORY,
  ARGON2_ITERATIONS,
  ARGON2_PARALLELISM,
} as const;
