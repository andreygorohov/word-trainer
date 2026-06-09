const CACHE = "wordtrainer-v2";
const ASSETS = [
	"./",
	"./index.html",
	"./css/main.css",
	"./js/words.js",
	"./js/main.js",
	"./manifest.json",
	"./icons/icon-192.png",
	"./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
			)
			.then(() => self.clients.claim())
	);
});

// Stale-while-revalidate: миттєво з кешу + фонове оновлення.
self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;

	event.respondWith(
		caches.open(CACHE).then((cache) =>
			cache.match(request).then((cached) => {
				const network = fetch(request)
					.then((response) => {
						if (response && response.status === 200 && response.type === "basic") {
							cache.put(request, response.clone());
						}
						return response;
					})
					.catch(() => cached);
				return cached || network;
			})
		)
	);
});
