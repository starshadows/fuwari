const configuredApiOrigin = normalizeOrigin(import.meta.env.PUBLIC_API_ORIGIN);

export function apiUrl(path: string): string {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	if (configuredApiOrigin && normalizedPath.startsWith("/api/")) {
		return `${configuredApiOrigin}${normalizedPath}`;
	}
	return normalizedPath;
}

export async function apiJson<T>(
	input: string,
	init?: RequestInit,
	fallbackMessage = "后端连接失败。",
): Promise<T> {
	const response = await fetch(input, init);
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		throw new Error(fallbackMessage);
	}

	const data = (await response.json()) as { error?: string } & T;
	if (!response.ok) throw new Error(data.error ?? fallbackMessage);
	return data;
}

function normalizeOrigin(value: string | undefined): string {
	if (!value) return "";
	try {
		return new URL(value).origin;
	} catch {
		return "";
	}
}
