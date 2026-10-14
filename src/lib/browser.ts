import { spawn } from 'node:child_process';

// opens a url in the default browser without waiting on it; failure is fine because the url is also printed.
export function openBrowser(url: string): void {
	const [command, args] = browserCommand(url);
	const child = spawn(command, args, {
		stdio: 'ignore',
		detached: true,
		windowsHide: true,
	});

	child.on('error', () => undefined);
	child.unref();
}

function browserCommand(url: string): [string, string[]] {
	if (process.platform === 'win32') {
		return ['rundll32', ['url.dll,FileProtocolHandler', url]];
	}

	if (process.platform === 'darwin') {
		return ['open', [url]];
	}

	return ['xdg-open', [url]];
}
