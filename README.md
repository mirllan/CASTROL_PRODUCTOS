# Proxy Portafolio Castrol

Cloudflare Worker que consulta el portafolio de productos de Castrol sin exponer el token del backend en la web.

## Endpoint

`GET /api/castrol/portafolio` devuelve la lista de productos en JSON.

Solo entrega los campos de `ALLOWED_FIELDS`, en `src/index.js`: `SAP`, `NOMBRE_PRODUCTO`, `CATEGORIA`, `MARCA`, `LINEA`, `PRESENTACION` y `TIPO_VEHICULO`. Todo lo que entrega el proxy debe considerarse público, porque el filtro de orígenes solo aplica en navegadores.

## Caché

La última respuesta válida se guarda en Workers KV. Durante 15 minutos se responde desde esa copia. Después se entrega la copia guardada mientras se actualiza en segundo plano, y si el backend falla se conserva la última copia válida.

## Desarrollo local

```bash
npm install
cp .dev.vars.example .dev.vars   # y pega el token en .dev.vars
npm run dev
```

## Publicar en Cloudflare

```bash
npx wrangler login
npx wrangler kv namespace create PORTAFOLIO_CACHE   # copia el id en wrangler.toml
npx wrangler secret put API_TOKEN
npm run deploy
```

Al terminar, el proxy queda en:
`https://castrol-portafolio-proxy.mirllan-dev.workers.dev/api/castrol/portafolio`

## Orígenes permitidos

La variable `ALLOWED_ORIGINS` de `wrangler.toml` define qué sitios pueden llamar al proxy desde el navegador. Si la web cambia de dominio, agrégalo ahí y vuelve a publicar.
