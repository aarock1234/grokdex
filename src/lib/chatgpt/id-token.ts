import { createPublicKey, verify } from 'node:crypto';

import { z } from 'zod';

import { SignInError } from '../errors.ts';
import { requestJson } from '../http.ts';
import { ISSUER, discover, nowSeconds } from './tokens.ts';

const headerSchema = z.object({
	alg: z.literal('RS256'),
	kid: z.string(),
});

const claimsSchema = z.object({
	iss: z.string(),
	aud: z.union([z.string(), z.array(z.string())]),
	exp: z.number(),
	sub: z.string(),
	nonce: z.string().optional(),
	email: z.string().optional(),
});

export type IdTokenClaims = z.infer<typeof claimsSchema>;

const jwksSchema = z.object({
	keys: z.array(
		z.looseObject({
			kid: z.string(),
			kty: z.string(),
		})
	),
});

type VerifyOptions = {
	clientId: string;
	nonce: string;
	signal?: AbortSignal;
};

// checks the signature against openai's published keys, then issuer, audience, expiry and nonce.
export async function verifyIdToken(idToken: string, options: VerifyOptions): Promise<IdTokenClaims> {
	const [headerSegment, payloadSegment, signatureSegment] = idToken.split('.');

	if (!headerSegment || !payloadSegment || !signatureSegment) {
		throw new SignInError('malformed id token');
	}

	const header = decodeSegment(headerSegment, headerSchema);
	const claims = decodeSegment(payloadSegment, claimsSchema);
	const { jwks_uri: jwksUri } = await discover(options.signal);
	const { keys } = await requestJson(jwksSchema, jwksUri, { signal: options.signal });
	const jwk = keys.find(key => key.kid === header.kid);

	if (!jwk) {
		throw new SignInError('id token signing key not found');
	}

	const signed = Buffer.from(`${headerSegment}.${payloadSegment}`);
	const signature = Buffer.from(signatureSegment, 'base64url');
	const publicKey = createPublicKey({
		key: jwk,
		format: 'jwk',
	});

	if (!verify('RSA-SHA256', signed, publicKey, signature)) {
		throw new SignInError('id token signature is invalid');
	}

	assertClaims(claims, options);

	return claims;
}

function assertClaims(claims: IdTokenClaims, options: VerifyOptions): void {
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

	if (claims.iss !== ISSUER) {
		throw new SignInError(`unexpected id token issuer ${claims.iss}`);
	}

	if (!audiences.includes(options.clientId)) {
		throw new SignInError('id token audience does not match the client id');
	}

	if (claims.exp <= nowSeconds()) {
		throw new SignInError('id token has expired');
	}

	if (claims.nonce !== options.nonce) {
		throw new SignInError('id token nonce mismatch');
	}
}

function decodeSegment<Schema extends z.ZodType>(segment: string, schema: Schema): z.output<Schema> {
	const data: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

	return schema.parse(data);
}
