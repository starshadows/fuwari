const PUBLIC_API_BASE = import.meta.env.PROD ? "https://api.starshadow.cc" : "";

export function apiUrl(path: string): string {
	return `${PUBLIC_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
