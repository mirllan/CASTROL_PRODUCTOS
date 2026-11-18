const PORTAFOLIO_PATH = "/api/castrol/portafolio";
const UPSTREAM_TIMEOUT_MS = 25000;
const CACHE_KEY = "portafolio:v1";
const DEFAULT_CACHE_FRESH_SECONDS = 900;

// Lista blanca: solo estos campos salen del proxy. Todo lo que se entrega aquí es público.
const ALLOWED_FIELDS = [
    "SAP",
    "NOMBRE_PRODUCTO",
    "CATEGORIA",
    "MARCA",
    "LINEA",
    "PRESENTACION",
    "TIPO_VEHICULO",
];

// En estos campos el backend agrega notas internas entre paréntesis, como "(FOCO PRINCIPAL)"
const FIELDS_WITH_INTERNAL_NOTES = new Set(["NOMBRE_PRODUCTO", "PRESENTACION"]);
const FILLER_VALUES = new Set(["NA", "N/A", "0"]);

function getAllowedOrigins(env) {
    return (env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function corsHeaders(origin) {
    if (!origin) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
}

function cleanValue(field, value) {
    let text = String(value ?? "").trim();
    if (FIELDS_WITH_INTERNAL_NOTES.has(field)) {
        text = text.replace(/\s*\([^)]*\)/g, "").trim();
    }
    return FILLER_VALUES.has(text.toUpperCase()) ? "" : text;
}

function toPublicProduct(row) {
    return Object.fromEntries(ALLOWED_FIELDS.map((field) => [field, cleanValue(field, row?.[field])]));
}

async function fetchProductos(env) {
    const response = await fetch(env.PORTAFOLIO_ENDPOINT_URL, {
        headers: {
            Authorization: `Token ${env.API_TOKEN}`,
            "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    // Si el backend responde 404 lo tratamos como "sin productos"
    if (response.status === 404) return [];

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status} del backend: ${text.substring(0, 500)}`);
    }

    const data = await response.json();
    const rows = Array.isArray(data) ? data : data?.result;
    if (!Array.isArray(rows)) {
        throw new Error("El backend respondió con un formato inesperado");
    }

    return rows.map(toPublicProduct).filter((product) => product.SAP || product.NOMBRE_PRODUCTO);
}

async function readCache(env) {
    try {
        const entry = await env.PORTAFOLIO_CACHE.get(CACHE_KEY, "json");
        return Array.isArray(entry?.productos) ? entry : null;
    } catch (err) {
        console.error("No se pudo leer la caché:", err);
        return null;
    }
}

async function writeCache(env, productos) {
    try {
        await env.PORTAFOLIO_CACHE.put(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), productos }));
    } catch (err) {
        console.error("No se pudo guardar la caché:", err);
    }
}

// Actualiza la copia sin hacer esperar al usuario. Si falla, la última copia válida se conserva.
async function refreshCache(env) {
    try {
        await writeCache(env, await fetchProductos(env));
    } catch (err) {
        console.error("No se pudo actualizar la caché:", err);
    }
}

function isFresh(entry, env) {
    const seconds = Number(env.CACHE_FRESH_SECONDS);
    const freshSeconds = seconds > 0 ? seconds : DEFAULT_CACHE_FRESH_SECONDS;
    return Date.now() - entry.savedAt < freshSeconds * 1000;
}

async function getPortafolio(env, ctx, headers) {
    const cached = await readCache(env);

    if (cached && isFresh(cached, env)) {
        return Response.json(cached.productos, { headers: { ...headers, "X-Cache-Status": "HIT" } });
    }

    if (!env.API_TOKEN) {
        console.error("Falta el secreto API_TOKEN");
        if (cached) {
            return Response.json(cached.productos, { headers: { ...headers, "X-Cache-Status": "STALE" } });
        }
        return Response.json({ error: "Proxy sin configurar" }, { status: 500, headers });
    }

    if (cached) {
        ctx.waitUntil(refreshCache(env));
        return Response.json(cached.productos, { headers: { ...headers, "X-Cache-Status": "STALE" } });
    }

    try {
        const productos = await fetchProductos(env);
        await writeCache(env, productos);
        return Response.json(productos, { headers: { ...headers, "X-Cache-Status": "MISS" } });
    } catch (err) {
        console.error("Error en el proxy:", err);
        const timedOut = err.name === "TimeoutError";
        return Response.json(
            { error: timedOut ? "El backend tardó demasiado en responder" : "Error al obtener los productos" },
            { status: timedOut ? 504 : 502, headers },
        );
    }
}

export default {
    async fetch(request, env, ctx) {
        const { pathname } = new URL(request.url);
        const origin = request.headers.get("Origin");

        if (origin && !getAllowedOrigins(env).includes(origin)) {
            return Response.json({ error: "Origen no permitido" }, { status: 403 });
        }

        const headers = { ...corsHeaders(origin), "Cache-Control": "no-store" };

        if (pathname !== PORTAFOLIO_PATH) {
            return Response.json({ error: "Ruta no encontrada" }, { status: 404, headers });
        }
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers });
        }
        if (request.method !== "GET") {
            return Response.json(
                { error: "Método no permitido" },
                { status: 405, headers: { ...headers, Allow: "GET, OPTIONS" } },
            );
        }

        return getPortafolio(env, ctx, headers);
    },
};
