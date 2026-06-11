const ADMIN_PAGE_PATH = "/friends/admin/";
const ADMIN_SHELL_PREFIX = "/worker-admin-shell/";
const PROXY_TOKEN_HEADER = "x-fuwari-proxy-token";
const PROXY_ORIGIN_HEADER = "x-fuwari-proxy-origin";
const PROXY_CLIENT_IP_HEADER = "x-fuwari-client-ip";

export const config = {
	matcher: [
		"/api/:path*",
		"/media/:path*",
		"/friends/admin",
		"/friends/admin/",
		"/friends/admin/index.html",
		"/worker-admin-shell/:path*",
	],
};

export default function middleware(request) {
	const url = new URL(request.url);

	if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
		return proxyWorkerRequest(request, url);
	}

	if (
		url.pathname === "/friends/admin" ||
		url.pathname === ADMIN_PAGE_PATH ||
		url.pathname === "/friends/admin/index.html"
	) {
		const workerOrigin = getWorkerOrigin();
		if (!workerOrigin) return missingWorkerOriginResponse();
		const redirectUrl = new URL(ADMIN_PAGE_PATH, workerOrigin);
		redirectUrl.search = url.search;
		return Response.redirect(redirectUrl.toString(), 307);
	}

	if (url.pathname.startsWith(ADMIN_SHELL_PREFIX)) {
		const expectedToken = process.env.CONTENT_SYNC_TOKEN;
		const requestToken = request.headers.get("x-fuwari-admin-shell-token");

		if (!expectedToken || requestToken !== expectedToken) {
			return new Response("Not found", {
				status: 404,
				headers: {
					"cache-control": "no-store",
					"x-robots-tag": "noindex,nofollow",
				},
			});
		}
	}
}

function proxyWorkerRequest(request, url) {
	const workerOrigin = getWorkerOrigin();
	if (!workerOrigin) return missingWorkerOriginResponse();

	const upstreamUrl = new URL(url.pathname, workerOrigin);
	upstreamUrl.search = url.search;
	const headers = new Headers(request.headers);
	const proxyToken = process.env.CONTENT_SYNC_TOKEN || "";
	if (proxyToken) headers.set(PROXY_TOKEN_HEADER, proxyToken);
	headers.set(PROXY_ORIGIN_HEADER, url.origin);
	const clientIp = firstForwardedIp(
		request.headers.get("x-forwarded-for") ||
			request.headers.get("x-real-ip") ||
			"",
	);
	if (clientIp) {
		headers.set(PROXY_CLIENT_IP_HEADER, clientIp);
		headers.set("x-real-ip", clientIp);
	}

	return fetch(upstreamUrl, {
		method: request.method,
		headers,
		body:
			request.method === "GET" || request.method === "HEAD"
				? undefined
				: request.body,
		redirect: "manual",
	});
}

function getWorkerOrigin() {
	return normalizeOrigin(
		process.env.PUBLIC_API_ORIGIN ||
			process.env.WORKER_ORIGIN ||
			process.env.FUWARI_WORKER_ORIGIN ||
			process.env.CONTENT_SYNC_BASE_URL ||
			process.env.FUWARI_CONTENT_API_BASE_URL ||
			"",
	);
}

function normalizeOrigin(value) {
	try {
		return new URL(value).origin;
	} catch {
		return "";
	}
}

function firstForwardedIp(value) {
	return value.split(",")[0]?.trim() || "";
}

function missingWorkerOriginResponse() {
	return new Response("Worker origin is not configured.", {
		status: 503,
		headers: { "cache-control": "no-store" },
	});
}
