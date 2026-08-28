import crypto from 'crypto';

const ENCRYPTED_PREFIX = 'enc:v1';

const encryptionKey = (secret: string): Buffer => {
  if (secret.length < 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be at least 32 characters');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
};

export const randomToken = (bytes = 32): string =>
  crypto.randomBytes(bytes).toString('base64url');

export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token, 'utf8').digest('hex');

export const isEncrypted = (value: string): boolean =>
  value.startsWith(`${ENCRYPTED_PREFIX}:`);

export const encryptSecret = (value: string, secret: string): string => {
  if (!value) return value;
  if (isEncrypted(value)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTED_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
};

export const decryptSecret = (value: string | null | undefined, secret: string): string | undefined => {
  if (!value) return undefined;
  if (!isEncrypted(value)) {
    throw new Error('Refusing to read an unencrypted secret');
  }

  const parts = value.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Invalid encrypted secret format');
  }

  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  const encrypted = Buffer.from(parts[4], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};
