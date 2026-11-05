import { randomBytes } from 'node:crypto';

// Tokens, authorization codes, client identifiers, pending-request
// identifiers, and cookie values: 32 random bytes in unpadded base64url.
export const randomIdentifier = () => randomBytes(32).toString('base64url');
