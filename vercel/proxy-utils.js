const PROXY_TOKEN_HEADER = "x-fuwari-proxy-token";
const PROXY_ORIGIN_HEADER = "x-fuwari-proxy-origin";
const PROXY_CLIENT_IP_HEADER = "x-fuwari-client-ip";

export async function proxyToWorker(request, response, upstreamPath) {
	const workerOrigin = getWorkerOrigin();
	if (!workerOrigin) {
		return sendJson(response, 503, {
			error: "WORKER_ORIGIN_NOT_CONFIGURED",
		});
	}

	const requestOrigin = getRequestOrigin(request);
	if (requestOrigin && normalizeOrigin(requestOrigin) === workerOrigin) {
		return sendJson(response, 508, { error: "WORKER_PROXY_LOOP" });
	}

	const requestUrl = new URL(
		request.url ?? upstreamPath,
		requestOrigin || workerOrigin,
	);
	const upstreamUrl = new URL(upstreamPath, workerOrigin);
	upstreamUrl.search = requestUrl.search;

	const headers = requestHeaders(request);

	const proxyToken = process.env.CONTENT_SYNC_TOKEN || "";
	if (proxyToken) headers.set(PROXY_TOKEN_HEADER, proxyToken);
	if (requestOrigin) headers.set(PROXY_ORIGIN_HEADER, requestOrigin);

	const clientIp = firstForwardedIp(
		request.headers["x-forwarded-for"] || request.headers["x-real-ip"] || "",
	);
	if (clientIp) {
		headers.set(PROXY_CLIENT_IP_HEADER, clientIp);
		headers.set("x-real-ip", clientIp);
	}

	const init = {
		method: request.method,
		headers,
		redirect: "manual",
	};
	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = Buffer.from(await readRequestBody(request));
	}

	const upstream = await fetch(upstreamUrl, init);
	response.statusCode = upstream.status;
	response.statusMessage = upstream.statusText;
	upstream.headers.forEach((value, key) => {
		if (!isSkippedResponseHeader(key)) response.setHeader(key, value);
	});

	if (request.method === "HEAD") {
		response.end();
		return;
	}

	response.end(Buffer.from(await upstream.arrayBuffer()));
}

export function originalPath(request, prefix) {
	const requestUrl = new URL(
		request.url ?? prefix,
		getRequestOrigin(request) || "https://example.com",
	);
	if (requestUrl.pathname.startsWith(prefix)) return requestUrl.pathname;

	const path = request.query?.path;
	const suffix = Array.isArray(path) ? path.join("/") : path || "";
	return `${prefix.replace(/\/$/, "")}/${suffix}`;
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

function getRequestOrigin(request) {
	const host = request.headers.host;
	if (!host) return "";
	const proto =
		firstForwardedValue(request.headers["x-forwarded-proto"]) || "https";
	return `${proto}://${host}`;
}

function requestHeaders(request) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (isSkippedRequestHeader(key) || value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
			continue;
		}
		headers.set(key, value);
	}
	return headers;
}

function firstForwardedIp(value) {
	return firstForwardedValue(value);
}

function firstForwardedValue(value) {
	return String(value).split(",")[0]?.trim() || "";
}

async function readRequestBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return Buffer.concat(chunks);
}

function sendJson(response, statusCode, body) {
	response.statusCode = statusCode;
	response.setHeader("cache-control", "no-store");
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(body));
}

function isHopByHopHeader(key) {
	return [
		"connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
	].includes(key.toLowerCase());
}

function isSkippedRequestHeader(key) {
	return (
		isHopByHopHeader(key) ||
		["content-length", "host"].includes(key.toLowerCase())
	);
}

function isSkippedResponseHeader(key) {
	return (
		isHopByHopHeader(key) ||
		["content-encoding", "content-length"].includes(key.toLowerCase())
	);
}
