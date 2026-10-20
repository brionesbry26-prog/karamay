// Prints freshly generated local secrets to paste into .env (works on Windows, macOS, Linux).
import { randomBytes } from 'node:crypto';

console.log(`DATA_ENCRYPTION_KEYS=1:${randomBytes(32).toString('base64')}`);
console.log(`IP_HASH_KEY=${randomBytes(32).toString('hex')}`);
