import { proxyToWorker } from "../vercel/proxy-utils.js";

export default async function handler(request, response) {
	const path = request.query?.path;
	const suffix = Array.isArray(path) ? path.join("/") : path || "";
	await proxyToWorker(request, response, `/media/${suffix}`);
}
