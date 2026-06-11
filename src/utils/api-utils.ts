const PRODUCTION_BLOG_HOST = "blog.starshadow.cc";
const PRODUCTION_API_ORIGIN = "https://api.starshadow.cc";

export function apiUrl(path: string): string {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	if (
		typeof window !== "undefined" &&
		window.location.hostname === PRODUCTION_BLOG_HOST &&
		normalizedPath.startsWith("/api/")
	) {
		return `${PRODUCTION_API_ORIGIN}${normalizedPath}`;
	}
	return normalizedPath;
}
