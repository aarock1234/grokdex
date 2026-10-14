type AppErrorOptions = {
	cause?: unknown;
};

// an expected failure whose message is safe to show the user as is.
export class AppError extends Error {
	readonly code: string;

	constructor(message: string, code: string, options?: AppErrorOptions) {
		super(message, options);
		this.name = this.constructor.name;
		this.code = code;
	}
}

export class UsageError extends AppError {
	constructor(message: string) {
		super(message, 'USAGE');
	}
}

export class NotSignedInError extends AppError {
	constructor(provider: string) {
		super(`not signed in to ${provider} (run: grokdex setup)`, 'NOT_SIGNED_IN');
	}
}

export class SignInError extends AppError {
	constructor(message: string, options?: AppErrorOptions) {
		super(message, 'SIGN_IN_FAILED', options);
	}
}

export class HttpError extends AppError {
	readonly status: number;

	constructor(status: number, message: string) {
		super(`http ${status}: ${message}`, 'HTTP_ERROR');
		this.status = status;
	}
}

// reads a message from any thrown value without assuming it is an error.
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
