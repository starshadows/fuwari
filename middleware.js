const ADMIN_PAGE_PATH = "/friends/admin/";
const ADMIN_SHELL_PREFIX = "/worker-admin-shell/";
const API_ADMIN_PAGE_URL = "https://api.starshadow.cc/friends/admin/";

export const config = {
	matcher: [
		"/friends/admin",
		"/friends/admin/",
		"/friends/admin/index.html",
		"/worker-admin-shell/:path*",
	],
};

export default function middleware(request) {
	const url = new URL(request.url);

	if (
		url.pathname === "/friends/admin" ||
		url.pathname === ADMIN_PAGE_PATH ||
		url.pathname === "/friends/admin/index.html"
	) {
		const redirectUrl = new URL(API_ADMIN_PAGE_URL);
		redirectUrl.search = url.search;
		return Response.redirect(redirectUrl.toString(), 307);
	}

	if (url.pathname.startsWith(ADMIN_SHELL_PREFIX)) {
		const expectedToken = process.env.ADMIN_SHELL_TOKEN;
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
