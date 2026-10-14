// parses untrusted text, returning undefined instead of throwing; validate the result with a schema.
export function parseJsonOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
