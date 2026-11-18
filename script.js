// ------------------------------------
// CONFIGURACIÓN
// ------------------------------------
const PROXY_URL = "https://castrol-portafolio-proxy.mirllan-dev.workers.dev";
const PRODUCTOS_URL = `${PROXY_URL}/api/castrol/portafolio`;
const MAX_RESULTS = 20;
const MIN_QUERY_LENGTH = 2;
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

const LABELS = {
    CARRO: "Carro",
    MOTO: "Moto",
    CAMION: "Camión",
    "CARRO Y MOTO": "Carro y moto",
    LUBRICANTE: "Lubricante",
    KIT: "Kit",
    "COMPONENTE KIT": "Componente de kit",
};

const VEHICLE_ICONS = {
    MOTO: "two_wheeler",
    CAMION: "local_shipping",
};

const searchInput = document.getElementById("searchInput");
const vehicleFilter = document.getElementById("vehicleFilter");
const categoryFilter = document.getElementById("categoryFilter");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
const darkModeToggle = document.getElementById("darkModeToggle");

let productos = [];
let fuse = null;

// ------------------------------------
// UTILIDADES
// ------------------------------------
// El backend usa "NA" y "0" cuando un dato no existe
function cleanText(value) {
    const text = String(value ?? "").trim();
    return ["NA", "N/A", "0"].includes(text.toUpperCase()) ? "" : text;
}

// Permite encontrar "20W-50" escribiendo "20w50" o "galón" escribiendo "galon"
function compactText(text) {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
}

function labelFor(value) {
    return LABELS[value.toUpperCase()] ?? value;
}

function mapProducto(row) {
    const producto = {
        sap: cleanText(row.SAP),
        nombre: cleanText(row.NOMBRE_PRODUCTO),
        categoria: cleanText(row.CATEGORIA),
        marca: cleanText(row.MARCA),
        linea: cleanText(row.LINEA),
        presentacion: cleanText(row.PRESENTACION),
        vehiculo: cleanText(row.TIPO_VEHICULO),
    };

    return {
        ...producto,
        // "CARRO Y MOTO" debe aparecer al filtrar por Carro y también por Moto
        vehiculos: producto.vehiculo.toUpperCase().split(/\s+Y\s+/).filter(Boolean),
        textoCompacto: [producto.nombre, producto.linea, producto.marca, producto.presentacion].map(compactText),
    };
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function setStatus(html, type = "") {
    statusEl.className = `status ${type}`.trim();
    statusEl.innerHTML = html;
}

// ------------------------------------
// CARGA DE PRODUCTOS
// ------------------------------------
// El backend a veces tarda en despertar, por eso se reintenta antes de mostrar un error
async function fetchProductos() {
    let lastError;

    for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(PRODUCTOS_URL);
            if (response.ok) return await response.json();
            lastError = new Error(`Error ${response.status}`);
        } catch (err) {
            lastError = err;
        }

        if (attempt < MAX_LOAD_ATTEMPTS) {
            setStatus("El servidor está tardando un poco, reintentando...");
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }

    throw lastError;
}

function fillFilter(select, values) {
    const options = [...new Set(values)]
        .sort((a, b) => labelFor(a).localeCompare(labelFor(b), "es"))
        .map(value => `<option value="${escapeHtml(value)}">${escapeHtml(labelFor(value))}</option>`)
        .join("");
    select.insertAdjacentHTML("beforeend", options);
}

async function loadProductos() {
    setStatus("Cargando productos...");

    try {
        const data = await fetchProductos();
        const rows = Array.isArray(data) ? data : data?.result ?? [];
        productos = rows.map(mapProducto);

        if (productos.length === 0) {
            searchInput.placeholder = "Sin productos";
            setStatus('<span class="material-icons">info</span>De momento no hay productos.', "empty");
            return;
        }

        fuse = new Fuse(productos, {
            keys: [
                { name: "nombre", weight: 0.5 },
                { name: "linea", weight: 0.2 },
                { name: "marca", weight: 0.15 },
                { name: "presentacion", weight: 0.15 },
            ],
            threshold: 0.35,
            ignoreLocation: true,
            ignoreDiacritics: true,
        });

        fillFilter(vehicleFilter, productos.flatMap(producto => producto.vehiculos));
        fillFilter(categoryFilter, productos.map(producto => producto.categoria.toUpperCase()).filter(Boolean));

        searchInput.disabled = false;
        vehicleFilter.disabled = false;
        categoryFilter.disabled = false;
        searchInput.placeholder = "Buscar por nombre, SAP, línea o marca...";
        searchInput.focus();
        setStatus(`${productos.length} productos cargados.`);
    } catch (err) {
        console.error("Error cargando productos:", err);
        searchInput.placeholder = "No se pudieron cargar los productos";
        setStatus(
            '<span class="material-icons">error_outline</span>No se pudieron cargar los productos. Intente de nuevo más tarde.',
            "error"
        );
    }
}

// ------------------------------------
// BÚSQUEDA
// ------------------------------------
function matchesFilters(producto) {
    const vehicle = vehicleFilter.value;
    const category = categoryFilter.value;
    return (!vehicle || producto.vehiculos.includes(vehicle))
        && (!category || producto.categoria.toUpperCase() === category);
}

function searchProductos(query) {
    const candidates = productos.filter(matchesFilters);
    if (query.length < MIN_QUERY_LENGTH) return candidates;

    // Un código SAP se busca exacto para no traer códigos parecidos
    if (/^\d+$/.test(query)) {
        const byCode = candidates.filter(producto => producto.sap === query);
        if (byCode.length > 0) return byCode;
    }

    // Lo que coincide literalmente va primero: "10W-30" no debe traer "10W-40"
    const compactQuery = compactText(query);
    if (compactQuery) {
        const literal = candidates.filter(producto => producto.textoCompacto.some(text => text.includes(compactQuery)));
        if (literal.length > 0) return literal;
    }

    return fuse.search(query).map(result => result.item).filter(matchesFilters);
}

function handleInput() {
    const query = searchInput.value.trim();
    const hasFilter = Boolean(vehicleFilter.value || categoryFilter.value);

    if (!fuse || (query.length < MIN_QUERY_LENGTH && !hasFilter)) {
        resultsEl.innerHTML = "";
        return;
    }

    const found = searchProductos(query);

    if (found.length === 0) {
        const message = query.length >= MIN_QUERY_LENGTH
            ? `No se encontraron resultados para "${escapeHtml(query)}".`
            : "No hay productos con estos filtros.";
        resultsEl.innerHTML = `<div class="status empty">${message}</div>`;
        return;
    }

    const note = found.length > MAX_RESULTS
        ? `<div class="status results-note">Mostrando ${MAX_RESULTS} de ${found.length} productos. Escribe o filtra para acotar.</div>`
        : "";

    resultsEl.innerHTML = note + found.slice(0, MAX_RESULTS).map(renderProducto).join("");
}

function copyButton(text, label) {
    return `<button type="button" class="material-icons copy-icon" title="Copiar" aria-label="Copiar ${label}" data-copy="${escapeHtml(text)}">content_copy</button>`;
}

function renderProducto(producto, index) {
    const tags = [labelFor(producto.categoria), labelFor(producto.linea)]
        .filter(Boolean)
        .filter((tag, position, list) => list.findIndex(other => other.toUpperCase() === tag.toUpperCase()) === position)
        .map(tag => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join("");

    const vehicleIcon = VEHICLE_ICONS[producto.vehiculo.toUpperCase()] ?? "directions_car";

    const items = [];
    if (producto.sap) items.push(`<li><span class="material-icons icon-tipo">tag</span><strong>SAP:</strong> ${escapeHtml(producto.sap)}${copyButton(producto.sap, "SAP")}</li>`);
    if (producto.marca) items.push(`<li><span class="material-icons icon-tipo">sell</span><strong>Marca:</strong> ${escapeHtml(producto.marca)}</li>`);
    if (producto.presentacion) items.push(`<li><span class="material-icons icon-tipo">inventory</span><strong>Presentación:</strong> ${escapeHtml(producto.presentacion)}</li>`);
    if (producto.vehiculo) items.push(`<li><span class="material-icons icon-tipo">${vehicleIcon}</span><strong>Vehículo:</strong> ${escapeHtml(labelFor(producto.vehiculo))}</li>`);

    return `
        <div class="result-item producto" style="animation-delay: ${index * 0.03}s">
            <h3><span class="material-icons icon-tipo">oil_barrel</span>${escapeHtml(producto.nombre || "Producto sin nombre")}</h3>
            ${tags ? `<div class="tags">${tags}</div>` : ""}
            <ul>${items.join("")}</ul>
        </div>`;
}

function copyText(button) {
    navigator.clipboard.writeText(button.dataset.copy).then(() => {
        button.textContent = "check";
        setTimeout(() => { button.textContent = "content_copy"; }, 1200);
    }).catch(err => console.error("No se pudo copiar:", err));
}

// ------------------------------------
// MODO OSCURO
// ------------------------------------
function applyDarkMode(enabled) {
    darkModeToggle.checked = enabled;
    document.body.classList.toggle("dark-mode", enabled);
    document.getElementById("darkModeLabel").textContent = enabled ? "☀️ Modo claro" : "🌙 Modo oscuro";
}

function toggleDarkMode() {
    applyDarkMode(darkModeToggle.checked);
    try { localStorage.setItem("darkMode", darkModeToggle.checked ? "1" : "0"); } catch (e) { /* sin almacenamiento */ }
}

function initDarkMode() {
    let saved = null;
    try { saved = localStorage.getItem("darkMode"); } catch (e) { /* sin almacenamiento */ }
    applyDarkMode(saved === "1");
}

// ------------------------------------
// INICIO
// ------------------------------------
searchInput.addEventListener("input", handleInput);
vehicleFilter.addEventListener("change", handleInput);
categoryFilter.addEventListener("change", handleInput);
darkModeToggle.addEventListener("change", toggleDarkMode);
resultsEl.addEventListener("click", event => {
    const button = event.target.closest(".copy-icon");
    if (button) copyText(button);
});

initDarkMode();
loadProductos();
