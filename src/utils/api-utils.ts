const configuredApiOrigin = normalizeOrigin(import.meta.env.PUBLIC_API_ORIGIN);

export function apiUrl(path: string): string {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	if (configuredApiOrigin && normalizedPath.startsWith("/api/")) {
		return `${configuredApiOrigin}${normalizedPath}`;
	}
	return normalizedPath;
}

function normalizeOrigin(value: string | undefined): string {
	if (!value) return "";
	try {
		return new URL(value).origin;
	} catch {
		return "";
	}
}
