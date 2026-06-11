import { originalPath, proxyToWorker } from "../vercel/proxy-utils.js";

export default async function handler(request, response) {
	await proxyToWorker(request, response, originalPath(request, "/api/"));
}
